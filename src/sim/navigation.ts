import type { AltitudeConstraint } from "./airport";

/** A fix on an aircraft's active route, already projected into local coordinates. */
export interface RoutePoint {
  id: string;
  eastNM: number;
  northNM: number;
  altitude?: AltitudeConstraint | null;
  maxSpeedKt?: number | null;
}

/** Localiser and glidepath for one runway, in local coordinates. */
export class ILSGeometry {
  constructor(
    public runwayId: string,
    public thresholdEastNM: number,
    public thresholdNorthNM: number,
    /** True bearing of the landing direction. */
    public courseDeg: number,
    public glidepathDeg: number,
    public thresholdElevationFt: number,
    public thresholdCrossingHeightFt: number,
    /** A visual approach to a runway without an ILS. */
    public isVisual = false,
  ) {}

  /** `along`: NM before the threshold on the final course. `cross`: NM right of the course line. */
  position(eastNM: number, northNM: number): { along: number; cross: number } {
    const re = eastNM - this.thresholdEastNM;
    const rn = northNM - this.thresholdNorthNM;
    const c = (this.courseDeg * Math.PI) / 180;
    return {
      along: -(re * Math.sin(c) + rn * Math.cos(c)),
      cross: re * Math.cos(c) - rn * Math.sin(c),
    };
  }

  glidepathAltitudeFt(distanceNM: number): number {
    return (
      this.thresholdElevationFt +
      this.thresholdCrossingHeightFt +
      Math.tan((this.glidepathDeg * Math.PI) / 180) * distanceNM * 6076.115
    );
  }
}

export type ApproachPhase = "intercepting" | "localiser" | "glideslope";

export interface ApproachClearance {
  ils: ILSGeometry;
  phase: ApproachPhase;
}

export type GroundPhase = "holdingShort" | "linedUp" | "takeoffRoll";
export const GROUND_LABEL: Record<GroundPhase, string> = {
  holdingShort: "HLD",
  linedUp: "LUP",
  takeoffRoll: "ROL",
};

export interface DepartureInfo {
  runway: string;
  sid: string;
  initialAltitudeFt: number;
  fieldElevationFt: number;
  rotateSpeedKt: number;
  checkedIn: boolean;
  handedOff: boolean;
  vectored: boolean;
  exitFix: string | null;
  expectedLevelFt: number;
  handoffAltitudeFt: number;
}

export type AircraftEvent =
  | { kind: "established"; runway: string }
  | { kind: "landed"; runway: string }
  | { kind: "wentAround"; reason: string }
  | { kind: "routeEnded"; fix: string; headingDeg: number }
  | { kind: "crossingUnable"; fix: string; altitudeFt: number }
  | { kind: "tookOff"; runway: string }
  | { kind: "checkedIn"; passingFt: number; climbingToFt: number; sid: string };

export type EmergencyKind =
  | "engineFailure" | "medical" | "lowFuel" | "hydraulicFailure" | "smoke" | "birdStrike" | "depressurisation"
  | "gearProblem";
export const EMERGENCY_KINDS: EmergencyKind[] = [
  "engineFailure", "medical", "lowFuel", "hydraulicFailure", "smoke", "birdStrike", "depressurisation", "gearProblem",
];

export function urgencyWord(k: EmergencyKind): string {
  switch (k) {
    case "medical": case "lowFuel": case "birdStrike": case "gearProblem": return "PAN PAN";
    default: return "MAYDAY";
  }
}

export function emergencyPhrase(k: EmergencyKind): string {
  return {
    engineFailure: "engine failure",
    medical: "medical emergency on board",
    lowFuel: "low fuel",
    hydraulicFailure: "hydraulic failure",
    smoke: "smoke in the cabin",
    birdStrike: "bird strike",
    depressurisation: "loss of pressurisation",
    gearProblem: "unsafe landing gear indication",
  }[k];
}

export function emergencyRequest(k: EmergencyKind): string {
  switch (k) {
    case "depressurisation": return "descending to ten thousand feet, request vectors for immediate landing";
    case "gearProblem": return "request vectors, we need time to run the checklist";
    case "lowFuel": return "request direct routing and priority landing";
    default: return "request vectors for immediate landing";
  }
}

export type PlannedEvent =
  | { kind: "pilotGoAround"; reason: string; triggerNM: number }
  | { kind: "windshear"; triggerNM: number }
  | { kind: "emergency"; emergency: EmergencyKind; atTick: number };

export interface EventSettings {
  pilotGoAroundPercent: number;
  windshearPercent: number;
  emergencyPercent: number;
}
export const EVENTS_OFF: EventSettings = { pilotGoAroundPercent: 0, windshearPercent: 0, emergencyPercent: 0 };
export const EVENTS_GAME_DEFAULT: EventSettings = { pilotGoAroundPercent: 3, windshearPercent: 2, emergencyPercent: 2 };
