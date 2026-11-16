import { SeededRNG } from "./rng";
import { AIRCRAFT_TYPES, airlinesFor, type AircraftCategory, type AircraftType } from "./types";

export type TrafficVariation = "steady" | "moderate" | "lively";
export const VARIATION_TITLE: Record<TrafficVariation, string> = { steady: "Steady", moderate: "Moderate", lively: "Lively" };

export const VARIATION = {
  steady: { interval: [1200, 1800], jump: 0.3, ease: 180 },
  moderate: { interval: [480, 900], jump: 0.6, ease: 120 },
  lively: { interval: [180, 480], jump: 1.0, ease: 60 },
} as const;

export interface TrafficSettings {
  enabled: boolean;
  arrivalsPerHour: number;
  departuresPerHour: number;
  ifr: boolean;
  vfr: boolean;
  enabledCategories: AircraftCategory[];
  disabledTypes: string[];
  /** Decimal string so it survives JSON; null means a fresh random seed each start. */
  fixedSeed: string | null;
  arrivalsMaxPerHour: number | null;
  departuresMaxPerHour: number | null;
  variation: TrafficVariation;
}

export function defaultTraffic(): TrafficSettings {
  return {
    enabled: true, arrivalsPerHour: 12, departuresPerHour: 8, ifr: true, vfr: false,
    enabledCategories: ["heavy", "narrowbody", "regional", "light"], disabledTypes: [], fixedSeed: null,
    arrivalsMaxPerHour: 24, departuresMaxPerHour: 14, variation: "moderate",
  };
}

export function arrivalRange(s: TrafficSettings): [number, number] {
  return [s.arrivalsPerHour, Math.max(s.arrivalsPerHour, s.arrivalsMaxPerHour ?? s.arrivalsPerHour)];
}
export function departureRange(s: TrafficSettings): [number, number] {
  return [s.departuresPerHour, Math.max(s.departuresPerHour, s.departuresMaxPerHour ?? s.departuresPerHour)];
}
export function isVariable(s: TrafficSettings): boolean {
  const a = arrivalRange(s), d = departureRange(s);
  return a[1] > a[0] || d[1] > d[0];
}

export interface TrafficPreset {
  name: string;
  arrivals: [number, number];
  variation: TrafficVariation;
  categories: AircraftCategory[];
}
const ALL4: AircraftCategory[] = ["heavy", "narrowbody", "regional", "light"];
export const TRAFFIC_PRESETS: TrafficPreset[] = [
  { name: "Quiet", arrivals: [2, 8], variation: "steady", categories: ALL4 },
  { name: "Moderate", arrivals: [12, 24], variation: "moderate", categories: ALL4 },
  { name: "Busy", arrivals: [25, 45], variation: "moderate", categories: ALL4 },
  { name: "Rush", arrivals: [30, 50], variation: "lively", categories: ALL4 },
  { name: "Airline only", arrivals: [20, 35], variation: "moderate", categories: ["heavy", "narrowbody", "regional"] },
  { name: "Heavy mix", arrivals: [15, 30], variation: "moderate", categories: ["heavy", "narrowbody"] },
  { name: "Turboprops and light", arrivals: [8, 18], variation: "moderate", categories: ["regional", "light"] },
];

export function applyPreset(p: TrafficPreset, s: TrafficSettings): void {
  s.arrivalsPerHour = p.arrivals[0];
  s.arrivalsMaxPerHour = p.arrivals[1];
  s.variation = p.variation;
  s.enabledCategories = [...p.categories];
  s.disabledTypes = [];
}

export function eligibleTypes(s: TrafficSettings): AircraftType[] {
  if (!s.ifr) return [];
  return AIRCRAFT_TYPES.filter((t) => t.canFlyIFR && s.enabledCategories.includes(t.category) && !s.disabledTypes.includes(t.code));
}

export function pick<T>(items: [T, number][], roll: number): T {
  const total = items.reduce((s, x) => s + x[1], 0);
  let target = roll * total;
  for (const [item, w] of items) {
    if (target < w) return item;
    target -= w;
  }
  return items[items.length - 1][0];
}

const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

/** A callsign not in `taken`: airline designator plus flight number, or a national registration. */
export function makeCallsign(type: AircraftType, country: string | null | undefined, rng: SeededRNG, taken: Set<string>): string {
  let candidate = "";
  const letter = () => LETTERS[Number(rng.next() % BigInt(LETTERS.length))];
  for (let attempt = 0; attempt < 40; attempt++) {
    const airlines = airlinesFor(type.category, country);
    if (airlines.length === 0) {
      if (country === "US") {
        const digits = 1 + Number(rng.next() % 3n);
        let text = "N" + String(1n + (rng.next() % 9n));
        for (let i = 1; i < digits; i++) text += String(rng.next() % 10n);
        const tail = rng.next() % 3n;
        if (tail === 0n) text += String(rng.next() % 10n) + String(rng.next() % 10n);
        else text += letter() + (tail === 1n ? letter() : "");
        candidate = text;
      } else if (country === "IE" || country == null) {
        candidate = "EI" + letter() + letter() + letter();
      } else {
        candidate = "G" + letter() + letter() + letter() + letter();
      }
    } else {
      const airline = pick(airlines, rng.unit());
      const span = airline.numbers[1] - airline.numbers[0] + 1;
      const number = airline.numbers[0] + Number(rng.next() % BigInt(span));
      candidate = airline.code + String(number);
    }
    if (!taken.has(candidate)) return candidate;
  }
  return candidate;
}
