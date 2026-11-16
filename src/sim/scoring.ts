// Scoring: points for moving traffic safely and efficiently, penalties for unsafe or wasteful control.
import type { EventSettings } from "./navigation";
import type { TrafficVariation } from "./traffic";
import { round } from "./util";

export type ScoreCategory = "arrivals" | "departures" | "efficiency" | "emergencies" | "safety" | "control" | "delays";
export const SCORE_CATEGORIES: ScoreCategory[] = ["arrivals", "departures", "efficiency", "emergencies", "safety", "control", "delays"];
export const CATEGORY_TITLE: Record<ScoreCategory, string> = {
  arrivals: "Arrivals", departures: "Departures", efficiency: "Efficiency", emergencies: "Emergencies",
  safety: "Separation", control: "Control", delays: "Delays",
};

export type ScoreKind =
  | "arrivalHandoff" | "landed" | "departureHandoff" | "departureAtPlanLevel" | "emergencyLanded" | "efficiency"
  | "lossOfSeparation" | "lossContinues" | "conflictAlert" | "goAroundCaused" | "missedHandoff" | "routeEndedNoClearance"
  | "refused" | "departureDelay" | "runwayHeadingUnvectored" | "emergencyIgnored" | "exitDirection" | "exitWrongWay";

export const KIND_CATEGORY: Record<ScoreKind, ScoreCategory> = {
  arrivalHandoff: "arrivals", landed: "arrivals",
  departureHandoff: "departures", departureAtPlanLevel: "departures", missedHandoff: "departures",
  exitDirection: "departures", exitWrongWay: "departures",
  efficiency: "efficiency",
  emergencyLanded: "emergencies", emergencyIgnored: "emergencies",
  lossOfSeparation: "safety", lossContinues: "safety", conflictAlert: "safety",
  goAroundCaused: "control", routeEndedNoClearance: "control", refused: "control", runwayHeadingUnvectored: "control",
  departureDelay: "delays",
};

export const KIND_TITLE: Record<ScoreKind, string> = {
  arrivalHandoff: "arrival handed to tower", landed: "landed", departureHandoff: "departure handed off",
  departureAtPlanLevel: "cleared to plan level", emergencyLanded: "emergency landed", efficiency: "efficient arrival",
  lossOfSeparation: "loss of separation", lossContinues: "loss of separation continues", conflictAlert: "conflict alert",
  goAroundCaused: "go-around", missedHandoff: "left the area without a handoff",
  routeEndedNoClearance: "route ended without a clearance", refused: "instruction refused",
  departureDelay: "departure waiting", runwayHeadingUnvectored: "departure not vectored",
  emergencyIgnored: "emergency waiting for a clearance", exitDirection: "handed off towards its exit",
  exitWrongWay: "handed off the wrong way",
};

export const ScoreRules = {
  points: {
    arrivalHandoff: 100, landed: 20, departureHandoff: 80, departureAtPlanLevel: 20, emergencyLanded: 30, efficiency: 30,
    lossOfSeparation: -300, lossContinues: -50, conflictAlert: -10, goAroundCaused: -100, missedHandoff: -150,
    routeEndedNoClearance: -50, refused: -5, departureDelay: -1, runwayHeadingUnvectored: -20, emergencyIgnored: -50,
    exitDirection: 20, exitWrongWay: -30,
  } as Record<ScoreKind, number>,
  exitAlignedDeg: 30.0,
  exitWrongWayDeg: 90.0,
  lossStepSeconds: 10,
  departureGraceSeconds: 180,
  runwayHeadingLimitNM: 10.0,
  emergencyWaitSeconds: 120,
  announceAtPoints: 100,
  efficiencyBonus(actualSeconds: number, cleanSeconds: number): number {
    if (cleanSeconds <= 0) return 0;
    const ratio = actualSeconds / cleanSeconds;
    const best = 30;
    if (ratio <= 1.2) return best;
    if (ratio >= 2.0) return 0;
    return round((best * (2.0 - ratio)) / 0.8);
  },
  cleanSeconds(distanceNM: number): number {
    return ((distanceNM * 1.3) / 210) * 3600;
  },
  isControllerGoAround(reason: string): boolean {
    return !(reason.startsWith("pilot's decision") || reason.startsWith("windshear"));
  },
};

export interface ScoreEvent {
  id: number;
  tick: number;
  kind: ScoreKind;
  points: number;
  callsign: string | null;
  detail: string;
}

export function scoreEventText(e: ScoreEvent): string {
  const sign = e.points >= 0 ? `+${e.points}` : `−${-e.points}`;
  const who = e.detail || e.callsign || "";
  return who ? `${sign} ${KIND_TITLE[e.kind]} ${who}` : `${sign} ${KIND_TITLE[e.kind]}`;
}

export interface ScoreSample {
  minute: number;
  rawScore: number;
  arrivalsPerHour: number;
  departuresPerHour: number;
}

export interface ArrivalTiming {
  callsign: string;
  actualSeconds: number;
  cleanSeconds: number;
  bonus: number;
  instructions: number;
}

export type ScoreGrade = "A" | "B" | "C" | "D" | "E";
export const GRADE_RANK: Record<ScoreGrade, string> = {
  A: "Supervisor", B: "Senior controller", C: "Controller", D: "Trainee", E: "Removed from position",
};

export class ScoreCard {
  events: ScoreEvent[] = [];
  raw = 0;
  multiplier = 1.0;
  samples: ScoreSample[] = [];
  arrivals: ArrivalTiming[] = [];
  arrivalsHandled = 0;
  departuresHandled = 0;
  losses = 0;
  controllerGoArounds = 0;
  missedHandoffs = 0;
  instructions = 0;
  startTick = 0;
  endTick: number | null = null;

  get total(): number {
    return round(this.raw * this.multiplier);
  }

  add(e: ScoreEvent): void {
    this.events.push(e);
    this.raw += e.points;
  }

  pointsIn(category: ScoreCategory): number {
    return this.events.filter((e) => KIND_CATEGORY[e.kind] === category).reduce((s, e) => s + e.points, 0);
  }

  count(kind: ScoreKind): number {
    return this.events.filter((e) => e.kind === kind).length;
  }

  durationSeconds(now: number): number {
    return Math.max(0, (this.endTick ?? now) - this.startTick);
  }

  worstMoments(limit = 8): ScoreEvent[] {
    return this.events
      .filter((e) => e.points <= -50)
      .sort((a, b) => a.points - b.points || a.tick - b.tick)
      .slice(0, limit);
  }

  get grade(): ScoreGrade | null {
    const potential = this.arrivalsHandled * 150 + this.departuresHandled * 120;
    if (potential <= 0) return null;
    const q = this.raw / potential;
    let g: ScoreGrade = q >= 0.85 ? "A" : q >= 0.7 ? "B" : q >= 0.5 ? "C" : q >= 0.3 ? "D" : "E";
    if (this.losses >= 3) g = "E";
    else if (this.losses >= 1 && (g === "A" || g === "B")) g = "C";
    return g;
  }

  get instructionsPerArrival(): number | null {
    if (this.arrivals.length === 0) return null;
    return this.arrivals.reduce((s, a) => s + a.instructions, 0) / this.arrivals.length;
  }
}

export function scoreMultiplier(averageRatePerHour: number | null, variable: boolean, variation: TrafficVariation,
                                events: EventSettings, liveWeather: boolean, gusting: boolean): number {
  let m = averageRatePerHour !== null ? Math.min(2.0, Math.max(0.5, averageRatePerHour / 23)) : 1.0;
  if (variable) {
    if (variation === "moderate") m *= 1.05;
    else if (variation === "lively") m *= 1.1;
  }
  if (events.pilotGoAroundPercent > 0) m += 0.05;
  if (events.windshearPercent > 0) m += 0.05;
  if (events.emergencyPercent > 0) m += 0.05;
  if (liveWeather) m += 0.05;
  if (gusting) m += 0.05;
  return round(m * 100) / 100;
}
