import { normalized, pad2, pad3, round } from "./util";

/** Surface wind, direction the wind blows FROM in degrees true, speed in knots. Stronger aloft. */
export class Wind {
  readonly fromDeg: number;
  readonly speedKt: number;
  readonly gustKt: number;

  static readonly calm = new Wind(0, 0);

  constructor(fromDeg: number, speedKt: number, gustKt?: number | null) {
    this.fromDeg = normalized(fromDeg);
    this.speedKt = Math.max(0, speedKt);
    this.gustKt = Math.max(this.speedKt, gustKt ?? speedKt);
  }

  get isGusting(): boolean {
    return this.gustKt > this.speedKt + 0.5;
  }

  equals(o: Wind): boolean {
    return this.fromDeg === o.fromDeg && this.speedKt === o.speedKt && this.gustKt === o.gustKt;
  }

  static altitudeScale(altitudeFt: number): number {
    return 1 + Math.min(Math.max(altitudeFt, 0), 30000) / 15000;
  }

  /** Velocity of the air over the ground in knots (east, north). */
  vectorKt(altitudeFt: number): { east: number; north: number } {
    const rad = (this.fromDeg * Math.PI) / 180;
    const speed = this.speedKt * Wind.altitudeScale(altitudeFt);
    return { east: -speed * Math.sin(rad), north: -speed * Math.cos(rad) };
  }

  /** `head` positive into wind, negative tailwind; `cross` absolute. */
  components(runwayBearingDeg: number, gusts = false): { head: number; cross: number } {
    const angle = ((this.fromDeg - runwayBearingDeg) * Math.PI) / 180;
    const speed = gusts ? this.gustKt : this.speedKt;
    return { head: speed * Math.cos(angle), cross: Math.abs(speed * Math.sin(angle)) };
  }

  /** "270/12", "270/12G22", or "calm". */
  get text(): string {
    if (this.speedKt < 0.5) return "calm";
    const r = round(this.fromDeg) % 360;
    const dir = r === 0 ? 360 : r;
    const gust = this.isGusting ? "G" + pad2(round(this.gustKt)) : "";
    return pad3(dir) + "/" + pad2(round(this.speedKt)) + gust;
  }
}

export const WindLimits = {
  maxTailwindKt: 5.0,
  maxCrosswindKt: 25.0,
  reopenMarginKt: 1.0,
  directionChangeKt: 2.0,
};

export interface RunwayStatus {
  id: string;
  isOpen: boolean;
  headwindKt: number;
  crosswindKt: number;
  reason: string;
}

export type WeatherMode = "live" | "random" | "fixed";
export const WEATHER_MODE_TITLES: Record<WeatherMode, string> = {
  live: "Live (METAR)",
  random: "Random",
  fixed: "Fixed",
};

export interface WeatherReport {
  icao: string;
  fromDeg: number | null;
  speedKt: number;
  gustKt: number | null;
  raw: string;
}

/** Reads the Aviation Weather Center METAR JSON (`/api/data/metar?ids=ICAO&format=json`). */
export function parseMetarJSON(json: unknown): WeatherReport | null {
  if (!Array.isArray(json) || json.length === 0) return null;
  const first = json[0] as Record<string, unknown>;
  const raw = typeof first.rawOb === "string" ? first.rawOb : "";
  const icao = typeof first.icaoId === "string" ? first.icaoId : "";
  const w = parseWind(raw);
  if (w) return { icao, fromDeg: w.fromDeg, speedKt: w.speedKt, gustKt: w.gustKt, raw };
  const num = (v: unknown): number | null => {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v);
    return null;
  };
  const speed = num(first.wspd);
  if (speed === null) return null;
  const dir = num(first.wdir);
  return { icao, fromDeg: speed < 1 ? null : dir, speedKt: speed, gustKt: num(first.wgst), raw };
}

export function parseWind(raw: string): { fromDeg: number | null; speedKt: number; gustKt: number | null } | null {
  const m = /\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)\b/.exec(raw);
  if (!m) return null;
  const scale = m[4] === "MPS" ? 1.943844 : 1.0;
  const gust = m[3] ? Number(m[3]) * scale : null;
  const dir = m[1] === "VRB" ? null : Number(m[1]);
  const knots = Number(m[2]) * scale;
  return { fromDeg: knots < 1 || dir === 0 ? null : dir, speedKt: knots, gustKt: gust };
}
