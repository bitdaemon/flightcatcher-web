import type { Aircraft } from "./aircraft";
import { Wind } from "./weather";

export const SeparationMinima = {
  lateralNM: 3.0,
  verticalFt: 1000.0,
  lookaheadSeconds: 120,
  independentParallelSpacingNM: 4300.0 / 6076.0,
  dependentParallelDiagonalNM: 1.5,
  parallelCourseToleranceDeg: 5.0,
};

export interface Conflict {
  first: string;
  second: string;
  kind: "predicted" | "loss";
  secondsToLoss: number;
  lateralNM: number;
  verticalFt: number;
  id: string;
}

function parallelApproachMinimum(a: Aircraft, b: Aircraft): number | null {
  const x = a.approach, y = b.approach;
  if (!x || !y || x.phase === "intercepting" || y.phase === "intercepting" || x.ils.runwayId === y.ils.runwayId) return null;
  let diff = Math.abs(x.ils.courseDeg - y.ils.courseDeg) % 360;
  if (diff > 180) diff = 360 - diff;
  if (diff > SeparationMinima.parallelCourseToleranceDeg) return null;
  const spacing = Math.abs(x.ils.position(y.ils.thresholdEastNM, y.ils.thresholdNorthNM).cross);
  return spacing >= SeparationMinima.independentParallelSpacingNM ? 0 : SeparationMinima.dependentParallelDiagonalNM;
}

/** Where an aircraft will be after `t` seconds, following its route fixes (turning instantly) or its heading. */
export function predictPosition(ac: Aircraft, wind: Wind, t: number): { east: number; north: number; altitude: number } {
  const delta = ac.targetAltitudeFt - ac.altitudeFt;
  const rate = ((delta >= 0 ? ac.climbRateFpm : ac.descentRateFpm) / 60) * t;
  const altitude = ac.altitudeFt + (delta >= 0 ? Math.min(rate, delta) : Math.max(-rate, delta));
  const w = wind.vectorKt(ac.altitudeFt);
  let east = ac.eastNM, north = ac.northNM;
  let heading = ac.headingDeg;
  let left = (ac.speedKt / 3600) * t;
  const followsRoute = ac.routeIndex < ac.route.length && (ac.approach === null || ac.approach.phase === "intercepting");
  if (followsRoute && left > 0) {
    for (let i = ac.routeIndex; i < ac.route.length; i++) {
      const point = ac.route[i];
      const dx = point.eastNM - east, dy = point.northNM - north;
      const d = Math.hypot(dx, dy);
      if (d <= 1e-6) continue;
      heading = (Math.atan2(dx, dy) * 180) / Math.PI;
      if (d >= left) {
        east += (dx / d) * left;
        north += (dy / d) * left;
        left = 0;
        break;
      }
      east = point.eastNM;
      north = point.northNM;
      left -= d;
    }
  }
  if (left > 0) {
    const rad = (heading * Math.PI) / 180;
    east += Math.sin(rad) * left;
    north += Math.cos(rad) * left;
  }
  return { east: east + (w.east / 3600) * t, north: north + (w.north / 3600) * t, altitude };
}

function check(a: Aircraft, b: Aircraft, wind: Wind, lateralNM: number, verticalFt: number, lookahead: number): Conflict | null {
  const parallel = parallelApproachMinimum(a, b);
  if (parallel !== null) {
    if (parallel === 0) return null;
    lateralNM = parallel;
  }
  const sep = (t: number) => {
    const pa = predictPosition(a, wind, t);
    const pb = predictPosition(b, wind, t);
    return { lateral: Math.hypot(pa.east - pb.east, pa.north - pb.north), vertical: Math.abs(pa.altitude - pb.altitude) };
  };
  const id = a.callsign + "/" + b.callsign;
  const now = sep(0);
  if (now.lateral < lateralNM && now.vertical < verticalFt) {
    return { first: a.callsign, second: b.callsign, kind: "loss", secondsToLoss: 0, lateralNM: now.lateral, verticalFt: now.vertical, id };
  }
  // Cheap reject: if they are far apart and cannot close within the look-ahead, skip the per-second scan.
  const closing = (a.speedKt + b.speedKt + 200) / 3600 * lookahead;
  if (now.lateral - closing > lateralNM) return null;
  for (let t = 1; t <= lookahead; t++) {
    const s = sep(t);
    if (s.lateral < lateralNM && s.vertical < verticalFt) {
      return { first: a.callsign, second: b.callsign, kind: "predicted", secondsToLoss: t, lateralNM: now.lateral, verticalFt: now.vertical, id };
    }
  }
  return null;
}

export function evaluateSeparation(aircraft: Aircraft[], wind: Wind = Wind.calm): Conflict[] {
  const result: Conflict[] = [];
  const live = aircraft.filter((x) => !x.landed && !x.isOnGround);
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const [a, b] = live[i].callsign < live[j].callsign ? [live[i], live[j]] : [live[j], live[i]];
      const c = check(a, b, wind, SeparationMinima.lateralNM, SeparationMinima.verticalFt, SeparationMinima.lookaheadSeconds);
      if (c) result.push(c);
    }
  }
  return result.sort((x, y) => {
    if (x.kind !== y.kind) return x.kind === "loss" ? -1 : 1;
    if (x.secondsToLoss !== y.secondsToLoss) return x.secondsToLoss - y.secondsToLoss;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });
}
