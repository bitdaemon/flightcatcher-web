// Aircraft types and airlines. Round-number approximations for gameplay, ported from SimCore/AircraftType.swift.

export type AircraftCategory = "heavy" | "narrowbody" | "regional" | "light" | "helicopter";
export const ALL_CATEGORIES: AircraftCategory[] = ["heavy", "narrowbody", "regional", "light", "helicopter"];
export const CATEGORY_TITLES: Record<AircraftCategory, string> = {
  heavy: "Heavy jets",
  narrowbody: "Narrowbody jets",
  regional: "Regional jets and turboprops",
  light: "Light aircraft",
  helicopter: "Helicopters",
};

export type WakeCategory = "L" | "M" | "H" | "J";

export interface AircraftType {
  code: string;
  name: string;
  category: AircraftCategory;
  wake: WakeCategory;
  canFlyIFR: boolean;
  turnRateDegPerSec: number;
  climbRateFpm: number;
  descentRateFpm: number;
  accelerationKtPerSec: number;
  minSpeedKt: number;
  maxSpeedKt: number;
  approachSpeedKt: number;
  ceilingFt: number;
  share: number;
}

function t(
  code: string, name: string, category: AircraftCategory, wake: WakeCategory, canFlyIFR: boolean,
  turn: number, climb: number, descent: number, accel: number, min: number, max: number, vapp: number,
  ceiling: number, share: number,
): AircraftType {
  return {
    code, name, category, wake, canFlyIFR, turnRateDegPerSec: turn, climbRateFpm: climb, descentRateFpm: descent,
    accelerationKtPerSec: accel, minSpeedKt: min, maxSpeedKt: max, approachSpeedKt: vapp, ceilingFt: ceiling, share,
  };
}

export const AIRCRAFT_TYPES: AircraftType[] = [
  t("A388", "Airbus A380-800", "heavy", "J", true, 2.5, 1700, 1800, 0.7, 150, 350, 145, 41000, 0.3),
  t("B77W", "Boeing 777-300ER", "heavy", "H", true, 2.5, 1800, 1900, 0.8, 150, 350, 150, 41000, 1),
  t("A333", "Airbus A330-300", "heavy", "H", true, 2.7, 1900, 1900, 0.9, 140, 350, 140, 41000, 1.2),
  t("B788", "Boeing 787-8", "heavy", "H", true, 2.8, 2200, 2000, 1.0, 140, 350, 140, 41000, 1),
  t("A320", "Airbus A320", "narrowbody", "M", true, 3, 2400, 2000, 1.0, 130, 350, 135, 39000, 3),
  t("A21N", "Airbus A321neo", "narrowbody", "M", true, 3, 2300, 2000, 1.0, 135, 350, 140, 39000, 1.5),
  t("B738", "Boeing 737-800", "narrowbody", "M", true, 3, 2500, 2000, 1.0, 130, 350, 138, 41000, 3),
  t("E190", "Embraer E190", "regional", "M", true, 3, 2500, 2000, 1.0, 125, 350, 125, 41000, 1),
  t("CRJ9", "Bombardier CRJ900", "regional", "M", true, 3, 2500, 2000, 1.0, 130, 350, 130, 41000, 0.7),
  t("AT76", "ATR 72-600", "regional", "M", true, 3, 1400, 1500, 0.8, 100, 250, 105, 25000, 1),
  t("DH8D", "De Havilland Dash 8 Q400", "regional", "M", true, 3, 1800, 1600, 0.9, 100, 250, 110, 27000, 0.8),
  t("PC12", "Pilatus PC-12", "light", "L", true, 3, 1700, 1500, 0.8, 90, 240, 85, 30000, 0.6),
  t("SR22", "Cirrus SR22", "light", "L", true, 3, 1200, 1000, 0.7, 80, 180, 80, 25000, 0.6),
  t("C172", "Cessna 172", "light", "L", false, 3, 700, 700, 0.5, 60, 120, 65, 13000, 2),
  t("PA28", "Piper PA-28", "light", "L", false, 3, 700, 700, 0.5, 65, 130, 70, 14000, 1.5),
  t("R44", "Robinson R44", "helicopter", "L", false, 4, 1000, 1000, 0.8, 40, 100, 50, 8000, 0.5),
  t("AW139", "Leonardo AW139", "helicopter", "M", false, 4, 1800, 1500, 1.0, 40, 150, 70, 15000, 0.3),
];

const TYPE_BY_CODE = new Map(AIRCRAFT_TYPES.map((x) => [x.code, x]));
export function aircraftType(code: string | null | undefined): AircraftType | undefined {
  return code ? TYPE_BY_CODE.get(code) : undefined;
}

type W = [home: number, abroad: number, us: number];
export interface Airline {
  code: string;
  radio: string;
  home: string;
  numbers: [number, number];
  weights: Partial<Record<AircraftCategory, W>>;
}

function al(code: string, radio: string, home: string, weights: Partial<Record<AircraftCategory, W>>,
            numbers: [number, number] = [1, 999]): Airline {
  return { code, radio, home, weights, numbers };
}

const M: [number, number] = [1, 2999];
const R: [number, number] = [3000, 6999];
const C: [number, number] = [1, 3999];

export const AIRLINES: Airline[] = [
  al("AAL", "American", "US", { heavy: [4, 2, 0], narrowbody: [6, 0, 0] }, M),
  al("DAL", "Delta", "US", { heavy: [4, 1, 0], narrowbody: [6, 0, 0] }, M),
  al("UAL", "United", "US", { heavy: [4, 1, 0], narrowbody: [6, 0, 0] }, M),
  al("SWA", "Southwest", "US", { narrowbody: [7, 0, 0] }, M),
  al("JBU", "JetBlue", "US", { narrowbody: [3, 0.5, 0] }, M),
  al("ASA", "Alaska", "US", { narrowbody: [3, 0, 0] }, M),
  al("NKS", "Spirit Wings", "US", { narrowbody: [2, 0, 0] }, M),
  al("FFT", "Frontier Flight", "US", { narrowbody: [2, 0, 0] }, M),
  al("AAY", "Allegiant", "US", { narrowbody: [1, 0, 0] }, M),
  al("HAL", "Hawaiian", "US", { heavy: [0.5, 0, 0], narrowbody: [0.5, 0, 0] }),
  al("SCX", "Sun Country", "US", { narrowbody: [1, 0, 0] }),
  al("FDX", "FedEx", "US", { heavy: [2, 1, 0] }, C),
  al("UPS", "UPS", "US", { heavy: [2, 1, 0] }, C),
  al("SKW", "SkyWest", "US", { regional: [4, 0, 0] }, R),
  al("RPA", "Brickyard", "US", { regional: [3, 0, 0] }, R),
  al("EDV", "Endeavor", "US", { regional: [3, 0, 0] }, R),
  al("ENY", "Envoy", "US", { regional: [3, 0, 0] }, R),
  al("JIA", "Blue Streak", "US", { regional: [2, 0, 0] }, R),
  al("PDT", "Piedmont", "US", { regional: [2, 0, 0] }, R),
  al("ASH", "Air Shuttle", "US", { regional: [2, 0, 0] }, R),
  al("GJS", "Lindbergh", "US", { regional: [1, 0, 0] }, R),
  al("QXE", "Horizon Air", "US", { regional: [1, 0, 0] }, R),
  al("EIN", "Shamrock", "IE", { heavy: [2, 2, 2], narrowbody: [3, 0.5, 0.5], regional: [3, 1, 0] }),
  al("RYR", "Ryanair", "IE", { narrowbody: [5, 1, 0] }),
  al("BAW", "Speedbird", "GB", { heavy: [3, 3, 3], narrowbody: [2, 2, 0], regional: [1, 1, 0] }),
  al("VIR", "Virgin", "GB", { heavy: [1, 1, 1] }),
  al("EZY", "Easy", "GB", { narrowbody: [2, 2, 0] }),
  al("DLH", "Lufthansa", "DE", { heavy: [2, 1, 2], narrowbody: [1, 1, 0] }),
  al("AFR", "Airfrans", "FR", { heavy: [1, 1, 1], narrowbody: [1, 1, 0] }),
  al("KLM", "KLM", "NL", { heavy: [1, 1, 1], narrowbody: [1, 1, 0], regional: [1, 1, 0] }),
  al("IBE", "Iberia", "ES", { heavy: [0.5, 0.5, 0.5], narrowbody: [1, 1, 0] }),
  al("VLG", "Vueling", "ES", { narrowbody: [1, 1, 0] }),
  al("SAS", "Scandinavian", "SE", { heavy: [0.5, 0.5, 0.5], narrowbody: [1, 1, 0], regional: [1, 1, 0] }),
  al("SWR", "Swiss", "CH", { heavy: [1, 1, 1], narrowbody: [1, 1, 0] }),
  al("AUA", "Austrian", "AT", { heavy: [0.5, 0.5, 0.5], narrowbody: [1, 1, 0] }),
  al("TAP", "Air Portugal", "PT", { heavy: [0.5, 0.5, 0.5], narrowbody: [1, 1, 0.5] }),
  al("LOT", "Lot", "PL", { heavy: [0.5, 0.5, 0.5], narrowbody: [1, 1, 0] }),
  al("FIN", "Finnair", "FI", { heavy: [0.5, 0.5, 0.5], narrowbody: [1, 1, 0] }),
  al("ICE", "Icelandair", "IS", { narrowbody: [1, 1, 1] }),
  al("THY", "Turkish", "TR", { heavy: [1.5, 1.5, 1.5], narrowbody: [1, 1, 0] }),
  al("NOZ", "Nor Shuttle", "NO", { narrowbody: [1, 1, 0] }),
  al("UAE", "Emirates", "AE", { heavy: [2, 2, 2] }),
  al("QTR", "Qatari", "QA", { heavy: [1, 1, 1] }),
  al("ETD", "Etihad", "AE", { heavy: [1, 1, 1] }),
  al("ELY", "El Al", "IL", { heavy: [0.5, 0.5, 0.5] }),
  al("ETH", "Ethiopian", "ET", { heavy: [0.5, 0.5, 0.5] }),
  al("SIA", "Singapore", "SG", { heavy: [1, 1, 1] }),
  al("CPA", "Cathay", "HK", { heavy: [1, 1, 1] }),
  al("JAL", "Japan Air", "JP", { heavy: [1, 1, 1] }),
  al("ANA", "All Nippon", "JP", { heavy: [1, 1, 1] }),
  al("KAL", "Korean Air", "KR", { heavy: [1, 1, 1] }),
  al("AAR", "Asiana", "KR", { heavy: [0.5, 0.5, 0.5] }),
  al("EVA", "Eva", "TW", { heavy: [1, 1, 1] }),
  al("CAL", "Dynasty", "TW", { heavy: [0.5, 0.5, 0.5] }),
  al("CCA", "Air China", "CN", { heavy: [0.5, 0.5, 0.5] }),
  al("AIC", "Air India", "IN", { heavy: [1, 1, 1] }),
  al("QFA", "Qantas", "AU", { heavy: [1, 1, 1] }),
  al("ANZ", "New Zealand", "NZ", { heavy: [0.5, 0.5, 0.5] }),
  al("ACA", "Air Canada", "CA", { heavy: [1.5, 1.5, 1.5], narrowbody: [2, 0.5, 2], regional: [0, 0, 0] }),
  al("WJA", "Westjet", "CA", { narrowbody: [1, 0.5, 1] }),
  al("AMX", "Aeromexico", "MX", { heavy: [0.5, 0.5, 0.5], narrowbody: [1, 0, 1] }),
  al("VOI", "Volaris", "MX", { narrowbody: [0.5, 0, 0.5] }),
  al("AVA", "Avianca", "CO", { heavy: [0.5, 0.5, 0.5], narrowbody: [0.5, 0, 0.5] }),
  al("CMP", "Copa", "PA", { narrowbody: [0.5, 0, 1] }),
  al("LAN", "Lan", "CL", { heavy: [0.5, 0.5, 0.5] }),
  al("AZU", "Azul", "BR", { heavy: [0.3, 0.3, 0.3] }),
];

export const RADIO_NAMES = new Map(AIRLINES.map((a) => [a.code, a.radio]));

export function airlineWeight(a: Airline, category: AircraftCategory, country: string | null | undefined): number {
  const w = a.weights[category];
  if (!w) return 0;
  if (country === a.home) return w[0];
  return country === "US" ? w[2] : w[1];
}

export function airlinesFor(category: AircraftCategory, country: string | null | undefined): [Airline, number][] {
  const out: [Airline, number][] = [];
  for (const a of AIRLINES) {
    const w = airlineWeight(a, category, country);
    if (w > 0) out.push([a, w]);
  }
  return out;
}
