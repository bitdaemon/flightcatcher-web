// Airport packages: the same JSON the macOS app bundles (built from FAA CIFP by Tools/cifp_to_package.py).

export interface LocalPoint {
  east: number;
  north: number;
}

/** Flat-earth projection around an origin, in nautical miles. Good enough for a terminal area. */
export class LocalProjection {
  constructor(public originLat: number, public originLon: number) {}

  nm(lat: number, lon: number): LocalPoint {
    return {
      east: (lon - this.originLon) * Math.cos((this.originLat * Math.PI) / 180) * 60,
      north: (lat - this.originLat) * 60,
    };
  }

  static offset(bearingDeg: number, distanceNM: number): LocalPoint {
    const b = (bearingDeg * Math.PI) / 180;
    return { east: Math.sin(b) * distanceNM, north: Math.cos(b) * distanceNM };
  }
}

export interface ILSData {
  ident: string;
  category: string;
  localiserMHz: number;
  glidepathDeg: number;
  thresholdCrossingHeightFt: number;
}

export interface Runway {
  id: string;
  trueBearingDeg: number;
  lengthM: number;
  widthM: number;
  surface: string;
  thresholdLat: number;
  thresholdLon: number;
  thresholdElevationFt: number;
  toraM: number;
  todaM: number;
  asdaM: number;
  ldaM: number;
  ils?: ILSData | null;
}

export interface Fix {
  id: string;
  lat: number;
  lon: number;
}

export type ProcedureKind = "sid" | "star" | "approach";
export type ApproachType = "ils" | "rnav" | "rnp";
export type AltitudeConstraintKind = "at" | "atOrAbove" | "atOrBelow" | "between";

export interface AltitudeConstraint {
  kind: AltitudeConstraintKind;
  feet: number;
  upperFeet?: number | null;
}

export interface Leg {
  fixId: string;
  altitude?: AltitudeConstraint | null;
  maxSpeedKt?: number | null;
}

export interface Procedure {
  id: string;
  kind: ProcedureKind;
  runways: string[];
  legs: Leg[];
  missedApproach?: Leg[] | null;
  note?: string | null;
  approachType?: ApproachType | null;
  glidepathDeg?: number | null;
}

export interface Hold {
  fixId: string;
  inboundMagneticDeg: number;
  turn: "left" | "right";
  maxSpeedKt: number;
  minAltitudeFt: number;
  maxLevelFt: number;
  outboundMinutes: number;
}

export interface AirportPackage {
  schemaVersion: number;
  icao: string;
  name: string;
  dataSource: string;
  transitionAltitudeFt: number;
  runways: Runway[];
  fixes: Fix[];
  procedures: Procedure[];
  holds: Hold[];
  elevationFt?: number | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  iata?: string | null;
}

export interface AirportIndexEntry {
  icao: string;
  name: string;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  iata?: string | null;
  ilsRunways: number;
  stars: number;
  sids: number;
  approaches: number;
  /** Added by the web build: size of the package in bytes, and whether it ships with the app. */
  bytes?: number;
  bundled?: boolean;
}

export function approachTypeOf(procedureId: string): ApproachType {
  switch (procedureId[0]) {
    case "R":
      return "rnav";
    case "H":
      return "rnp";
    default:
      return "ils";
  }
}

export function spokenApproachType(t: ApproachType): string {
  return t === "ils" ? "ILS" : t === "rnav" ? "RNAV" : "RNAV RNP";
}

export function finalApproachType(p: Procedure): ApproachType {
  return p.approachType ?? "ils";
}

export function airportTitle(city: string | null | undefined, name: string, icao: string): string {
  const place = city && city.length > 0 ? city : name;
  return `${place} (${icao})`;
}

export function entrySubtitle(e: AirportIndexEntry): string {
  const place = [e.region, e.country].filter((x) => x && x.length > 0).join(" ");
  return place ? `${e.name}, ${place}` : e.name;
}

export function entryMatches(e: AirportIndexEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [e.city, e.name, e.icao, e.iata, e.region, e.country]
    .filter((x): x is string => !!x)
    .some((x) => x.toLowerCase().includes(q));
}

/** Local projection centred on the mean of the runway thresholds. The scope and the simulation share it. */
export function referenceProjection(a: AirportPackage): LocalProjection {
  if (a.runways.length === 0) return new LocalProjection(0, 0);
  const n = a.runways.length;
  return new LocalProjection(
    a.runways.reduce((s, r) => s + r.thresholdLat, 0) / n,
    a.runways.reduce((s, r) => s + r.thresholdLon, 0) / n,
  );
}

export interface ApproachJoin {
  procedure: string;
  runway: string;
  via: string;
}

/** Approach procedures that can be joined with `j ID`, by procedure ID ("I04R", "I27.AYBEE"). */
export function approachJoins(a: AirportPackage): Map<string, ApproachJoin> {
  const table = new Map<string, ApproachJoin>();
  for (const p of a.procedures) {
    if (p.kind !== "approach") continue;
    const runway = p.runways[0];
    const via = p.legs[0]?.fixId;
    if (!runway || !via) continue;
    table.set(p.id.toUpperCase(), { procedure: p.id, runway, via });
  }
  return table;
}
