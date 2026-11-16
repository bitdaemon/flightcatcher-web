// Deterministic, UI-free simulation. One call to `tick()` advances one second of simulated time.
// Ported from SimCore/Simulation.swift. The debug log and the test spawner are not ported.
import { Aircraft } from "./aircraft";
import {
  finalApproachType, LocalProjection, referenceProjection, spokenApproachType, type AirportPackage, type Leg,
  type LocalPoint, type Procedure, type ProcedureKind, type Runway,
} from "./airport";
import { chainCode, commandRefusal, CommandLimits, EXIT_FIX_TOKEN, type Command, type IssuedCommand } from "./command";
import {
  EMERGENCY_KINDS, emergencyPhrase, emergencyRequest, EVENTS_OFF, ILSGeometry, urgencyWord, type EventSettings,
  type PlannedEvent, type RoutePoint,
} from "./navigation";
import * as P from "./phraseology";
import { SeededRNG } from "./rng";
import { ScoreCard, scoreEventText, scoreMultiplier, ScoreRules, type ScoreKind } from "./scoring";
import { evaluateSeparation, SeparationMinima, type Conflict } from "./separation";
import {
  arrivalRange, defaultTraffic, departureRange, eligibleTypes, isVariable, makeCallsign, pick, VARIATION,
  type TrafficSettings,
} from "./traffic";
import { AIRCRAFT_TYPES, type AircraftType } from "./types";
import { bearingDeg, hypot, round, signedTurn } from "./util";
import { nextStep, phaseOf, PHASE_LABEL, triggerHolds, triggerLabel, type CompiledMacro, type MacroRun, type MacroTrigger } from "./macro";
import { Wind, WindLimits, type RunwayStatus, type WeatherMode, type WeatherReport } from "./weather";

export type Speaker = "controller" | "pilot" | "system";
export type RadioTag =
  | "MAYDAY" | "PAN PAN" | "EMERG" | "LOSS" | "CONFLICT" | "G/A" | "WSHEAR" | "REFUSED" | "UNABLE" | "HIGH" | "M!";
export function tagSeverity(t: RadioTag): "critical" | "warning" {
  return t === "MAYDAY" || t === "PAN PAN" || t === "EMERG" || t === "LOSS" ? "critical" : "warning";
}

export interface RadioMessage {
  id: number;
  tick: number;
  speaker: Speaker;
  text: string;
  callsign?: string;
  tag?: RadioTag;
  code?: string;
}

export type RunwayUse = { kind: "departing"; callsign: string } | { kind: "landing"; callsign: string; nm: number };
export type IssueResult = { accepted: true; delaySeconds: number } | { accepted: false; reason: string };

export interface CommandRecord {
  id: number;
  callsign: string;
  command: Command;
  issuedTick: number;
  executeAtTick: number;
}

interface PendingCommand {
  executeAtTick: number;
  callsign: string;
  command: Command;
  readback: string;
}

const SALT_WEATHER = 0x5ea74e12d00df00dn;
const SALT_TRAFFIC = 0x7af1c5eed0f12b3dn;
const SALT_EVENTS = 0x3e0e17ac91d56b21n;
const SALT_RATE = 0x51c3d7a09e3779b9n;

export function oppositeRunway(id: string): string {
  const digits = /^\d*/.exec(id)![0];
  const suffix = id.slice(digits.length);
  if (!digits) return id;
  let other = (Number(digits) + 18) % 36;
  if (other === 0) other = 36;
  const flipped = suffix === "L" ? "R" : suffix === "R" ? "L" : suffix;
  return (other < 10 ? "0" : "") + String(other) + flipped;
}

export class Simulation {
  readonly seed: bigint;
  readonly transitionAltitudeFt: number;
  readonly airport: AirportPackage | null;
  tickCount = 0;
  aircraft: Aircraft[] = [];
  radioLog: RadioMessage[] = [];
  conflicts: Conflict[] = [];
  lossOfSeparationCount = 0;
  missedHandoffs = 0;
  areaRadiusNM = 40;
  areaCeilingFt = 15000;
  private alertedKinds = new Map<string, Conflict["kind"]>();

  score = new ScoreCard();
  private nextScoreID = 0;
  private arrivalStart = new Map<string, { tick: number; east: number; north: number }>();
  private instructionCounts = new Map<string, number>();
  private lastInstructionTick = new Map<string, number>();
  private lossSeconds = new Map<string, number>();
  private holdingSince = new Map<string, number>();
  private runwayHeadingPenalised = new Set<string>();
  private emergencySince = new Map<string, number>();
  private emergencyChecked = new Set<string>();
  private rateSeconds = 0;
  private rateSum = 0;

  wind: Wind = Wind.calm;
  runwayStatuses: RunwayStatus[] = [];
  private weatherRng: SeededRNG;
  private windDrifts: boolean;
  weatherMode: WeatherMode = "random";
  private windTarget: Wind | null = null;
  liveReport: WeatherReport | null = null;

  private pending: PendingCommand[] = [];
  commandHistory = new Map<string, CommandRecord[]>();
  static readonly historyLimit = 12;
  private nextRecordID = 0;

  private _traffic: TrafficSettings = { ...defaultTraffic(), enabled: false };
  private trafficRng: SeededRNG;
  private rateRng: SeededRNG;
  arrivalRatePerHour = 0;
  departureRatePerHour = 0;
  arrivalTargetPerHour = 0;
  departureTargetPerHour = 0;
  private nextRateChangeTick = 0;
  private ratesStarted = false;
  events: EventSettings = { ...EVENTS_OFF };
  private eventRng: SeededRNG;
  private queuedArrivals = 0;
  private nextMessageID = 0;
  private rng: SeededRNG;
  private projection: LocalProjection | null;
  private fixIndex = new Map<string, LocalPoint>();

  private interceptStall = new Map<string, number>();
  private interceptCalled = new Set<string>();
  private highStall = new Map<string, number>();
  private highCalled = new Set<string>();
  static readonly interceptStallCallSeconds = 20;
  static readonly highCallSeconds = 5;

  constructor(seed: bigint, transitionAltitudeFt = 5000, airport: AirportPackage | null = null,
              initialWind: Wind | null = null, windDrifts = true) {
    this.seed = seed;
    this.transitionAltitudeFt = transitionAltitudeFt;
    this.airport = airport;
    this.rng = new SeededRNG(seed);
    this.weatherRng = new SeededRNG(seed ^ SALT_WEATHER);
    this.trafficRng = new SeededRNG(seed ^ SALT_TRAFFIC);
    this.eventRng = new SeededRNG(seed ^ SALT_EVENTS);
    this.rateRng = new SeededRNG(seed ^ SALT_RATE);
    this.windDrifts = windDrifts;
    if (airport) {
      const proj = referenceProjection(airport);
      this.projection = proj;
      for (const fix of airport.fixes) this.fixIndex.set(fix.id, proj.nm(fix.lat, fix.lon));
    } else {
      this.projection = null;
    }
    if (airport && airport.runways.length > 0) {
      if (initialWind) this.wind = initialWind;
      else {
        const runway = airport.runways[this.weatherRng.below(airport.runways.length)];
        this.wind = new Wind(runway.trueBearingDeg + this.weatherRng.unit() * 80 - 40, 6 + this.weatherRng.unit() * 14);
      }
      this.runwayStatuses = this.evaluateRunways(this.wind, new Set(airport.runways.map((r) => r.id)));
    }
  }

  get traffic(): TrafficSettings {
    return this._traffic;
  }
  set traffic(t: TrafficSettings) {
    const was = this._traffic.enabled;
    this._traffic = t;
    if (t.enabled && !was) this.queuedArrivals = Math.max(this.queuedArrivals, 1);
  }

  get openRunways(): Set<string> {
    return new Set(this.runwayStatuses.filter((s) => s.isOpen).map((s) => s.id));
  }

  // MARK: Weather

  private evaluateRunways(wind: Wind, previouslyOpen: Set<string>): RunwayStatus[] {
    if (!this.airport) return [];
    const statuses: RunwayStatus[] = this.airport.runways.map((runway) => {
      const c = wind.components(runway.trueBearingDeg);
      const g = wind.components(runway.trueBearingDeg, true);
      const margin = previouslyOpen.has(runway.id) ? 0 : WindLimits.reopenMarginKt;
      const tailwind = Math.max(0, -g.head);
      const gusty = wind.isGusting ? " (gusts)" : "";
      let reason = "";
      if (tailwind > WindLimits.maxTailwindKt - margin) reason = `tailwind ${round(tailwind)} kt` + gusty;
      else if (g.cross > WindLimits.maxCrosswindKt - margin) reason = `crosswind ${round(g.cross)} kt` + gusty;
      return { id: runway.id, isOpen: reason === "", headwindKt: c.head, crosswindKt: c.cross, reason };
    });
    for (let i = 0; i < statuses.length; i++) {
      const j = statuses.findIndex((s) => s.id === oppositeRunway(statuses[i].id));
      if (j < 0 || j <= i || !statuses[i].isOpen || !statuses[j].isOpen) continue;
      let keepFirst = statuses[i].headwindKt >= statuses[j].headwindKt;
      const firstWas = previouslyOpen.has(statuses[i].id);
      const secondWas = previouslyOpen.has(statuses[j].id);
      if (firstWas !== secondWas && Math.abs(statuses[i].headwindKt - statuses[j].headwindKt) <= WindLimits.directionChangeKt) {
        keepFirst = firstWas;
      }
      const loser = keepFirst ? j : i;
      statuses[loser].isOpen = false;
      statuses[loser].reason = `runway ${statuses[keepFirst ? i : j].id} in use`;
    }
    return statuses;
  }

  private driftWind(): void {
    if (!this.airport || this.weatherMode === "fixed") return;
    let candidate: Wind;
    if (this.weatherMode === "live" && this.windTarget) {
      candidate = Simulation.easeWind(this.wind, this.windTarget);
      if (candidate.equals(this.wind)) return;
    } else {
      if (!this.windDrifts) return;
      candidate = new Wind(this.wind.fromDeg + this.weatherRng.unit() * 8 - 4,
        Math.min(25, Math.max(2, this.wind.speedKt + this.weatherRng.unit() * 2 - 1)));
    }
    const before = this.openRunways;
    const statuses = this.evaluateRunways(candidate, before);
    if (!statuses.some((s) => s.isOpen)) return;
    this.wind = candidate;
    this.runwayStatuses = statuses;
    for (const s of statuses) {
      if (before.has(s.id) && !s.isOpen) this.log("system", `Runway ${s.id} closed: ${s.reason}`);
      else if (!before.has(s.id) && s.isOpen) this.log("system", `Runway ${s.id} open again`);
    }
  }

  static easeWind(current: Wind, target: Wind): Wind {
    const step = (from: number, to: number, limit: number) => from + Math.max(-limit, Math.min(limit, to - from));
    const turn = Math.max(-10, Math.min(10, signedTurn(current.fromDeg, target.fromDeg)));
    return new Wind(current.fromDeg + turn, step(current.speedKt, target.speedKt, 2), step(current.gustKt, target.gustKt, 2));
  }

  setLiveWeather(report: WeatherReport, immediately = false): void {
    this.liveReport = report;
    const target = new Wind(report.fromDeg ?? this.wind.fromDeg, report.speedKt, report.gustKt);
    this.windTarget = target;
    if (!immediately || !this.airport) return;
    const statuses = this.evaluateRunways(target, new Set(this.airport.runways.map((r) => r.id)));
    if (!statuses.some((s) => s.isOpen)) return;
    this.wind = target;
    this.runwayStatuses = statuses;
  }

  isAvailable(p: Procedure): boolean {
    if (!this.airport || p.runways.length === 0) return true;
    const open = this.openRunways;
    return p.runways.some((r) => open.has(r));
  }

  closedReason(runway: string): string | null {
    const s = this.runwayStatuses.find((x) => x.id === runway);
    return s && !s.isOpen ? s.reason : null;
  }

  // MARK: Airport data

  routePoints(legs: Leg[]): RoutePoint[] {
    const out: RoutePoint[] = [];
    for (const leg of legs) {
      const p = this.fixIndex.get(leg.fixId);
      if (!p) continue;
      out.push({ id: leg.fixId, eastNM: p.east, northNM: p.north, altitude: leg.altitude, maxSpeedKt: leg.maxSpeedKt });
    }
    return out;
  }

  private runway(id: string): Runway | undefined {
    return this.airport?.runways.find((r) => r.id === id);
  }

  ilsGeometry(id: string): ILSGeometry | null {
    const rwy = this.runway(id);
    if (!rwy || !rwy.ils || !this.projection) return null;
    const t = this.projection.nm(rwy.thresholdLat, rwy.thresholdLon);
    return new ILSGeometry(id, t.east, t.north, rwy.trueBearingDeg, rwy.ils.glidepathDeg, rwy.thresholdElevationFt,
      rwy.ils.thresholdCrossingHeightFt);
  }

  approachGeometry(id: string): ILSGeometry | null {
    const ils = this.ilsGeometry(id);
    if (ils) return ils;
    const rwy = this.runway(id);
    if (!rwy || !this.projection) return null;
    const t = this.projection.nm(rwy.thresholdLat, rwy.thresholdLon);
    return new ILSGeometry(id, t.east, t.north, rwy.trueBearingDeg, 3.0, rwy.thresholdElevationFt, 50, true);
  }

  approachGeometryFor(p: Procedure): ILSGeometry | null {
    const runway = p.runways[0];
    if (!runway) return null;
    if (finalApproachType(p) === "ils") return this.ilsGeometry(runway);
    const rwy = this.runway(runway);
    if (!rwy || !this.projection) return null;
    const t = this.projection.nm(rwy.thresholdLat, rwy.thresholdLon);
    return new ILSGeometry(runway, t.east, t.north, rwy.trueBearingDeg, p.glidepathDeg ?? 3.0, rwy.thresholdElevationFt,
      rwy.ils?.thresholdCrossingHeightFt ?? 50);
  }

  isVisualRunway(id: string): boolean {
    const r = this.runway(id);
    return r ? !r.ils : false;
  }

  private approachLegs(runway: string, fix: string): RoutePoint[] {
    const proc = this.airport?.procedures.find((p) =>
      p.kind === "approach" && finalApproachType(p) === "ils" && p.runways.includes(runway) && p.legs[0]?.fixId === fix);
    return proc ? this.routePoints(proc.legs.slice(1)) : [];
  }

  get fixIdentifiers(): Set<string> {
    return new Set(this.fixIndex.keys());
  }

  fixPosition(id: string): LocalPoint | undefined {
    return this.fixIndex.get(id);
  }

  private directRoute(ac: Aircraft, fix: string): RoutePoint[] {
    for (let i = ac.routeIndex; i < ac.route.length; i++) {
      if (ac.route[i].id === fix) return ac.route.slice(i);
    }
    const airport = this.airport;
    if (!airport) return [];
    if (ac.departure) return this.routePoints([{ fixId: fix }]);
    const preferredRunway = ac.approach?.ils.runwayId;
    const tail = (kind: ProcedureKind): RoutePoint[] | null => {
      for (const proc of airport.procedures) {
        if (proc.kind !== kind || !this.isAvailable(proc)) continue;
        if (kind === "approach" && preferredRunway && !proc.runways.includes(preferredRunway)) continue;
        const i = proc.legs.findIndex((l) => l.fixId === fix);
        if (i >= 0) return this.routePoints(proc.legs.slice(i));
      }
      return null;
    };
    return tail("star") ?? tail("approach") ?? this.routePoints([{ fixId: fix }]);
  }

  // MARK: Spawning

  reseedTraffic(seed: bigint): void {
    this.trafficRng = new SeededRNG(seed ^ SALT_TRAFFIC);
    this.rateRng = new SeededRNG(seed ^ SALT_RATE);
    this.ratesStarted = false;
  }

  private spawnTraffic(): void {
    const roll = this.trafficRng.unit();
    this.updateTrafficRates();
    if (!this._traffic.enabled || !this.airport) return;
    if (roll < this.arrivalRatePerHour / 3600) this.queuedArrivals++;
    if (this.departureRatePerHour > 0 && this.trafficRng.unit() < this.departureRatePerHour / 3600) this.spawnDeparture();
    if (this.queuedArrivals <= 0) return;
    const outcome = this.spawnArrival();
    if (outcome === "spawned") this.queuedArrivals--;
    else if (outcome === "blocked") this.queuedArrivals = Math.min(this.queuedArrivals, 4);
    else this.queuedArrivals = 0;
  }

  private updateTrafficRates(): void {
    const a = arrivalRange(this._traffic), d = departureRange(this._traffic);
    if (!isVariable(this._traffic)) {
      this.arrivalRatePerHour = a[0]; this.arrivalTargetPerHour = a[0];
      this.departureRatePerHour = d[0]; this.departureTargetPerHour = d[0];
      this.ratesStarted = false;
      return;
    }
    const v = VARIATION[this._traffic.variation];
    if (!this.ratesStarted) {
      this.arrivalTargetPerHour = this.pickRate(a, null, 1);
      this.departureTargetPerHour = this.pickRate(d, null, 1);
      this.arrivalRatePerHour = this.arrivalTargetPerHour;
      this.departureRatePerHour = this.departureTargetPerHour;
      this.nextRateChangeTick = this.tickCount + this.rateInterval();
      this.ratesStarted = true;
    } else if (this.tickCount >= this.nextRateChangeTick) {
      this.arrivalTargetPerHour = this.pickRate(a, this.arrivalRatePerHour, v.jump);
      this.departureTargetPerHour = this.pickRate(d, this.departureRatePerHour, v.jump);
      this.nextRateChangeTick = this.tickCount + this.rateInterval();
    }
    this.arrivalTargetPerHour = Math.min(Math.max(this.arrivalTargetPerHour, a[0]), a[1]);
    this.departureTargetPerHour = Math.min(Math.max(this.departureTargetPerHour, d[0]), d[1]);
    const k = Math.min(1, 3 / v.ease);
    this.arrivalRatePerHour = Math.min(Math.max(this.arrivalRatePerHour + (this.arrivalTargetPerHour - this.arrivalRatePerHour) * k, a[0]), a[1]);
    this.departureRatePerHour = Math.min(Math.max(this.departureRatePerHour + (this.departureTargetPerHour - this.departureRatePerHour) * k, d[0]), d[1]);
  }

  private rateInterval(): number {
    const v = VARIATION[this._traffic.variation];
    return Math.trunc(v.interval[0] + this.rateRng.unit() * (v.interval[1] - v.interval[0]));
  }

  private pickRate(range: [number, number], current: number | null, jump: number): number {
    const width = range[1] - range[0];
    const u = this.rateRng.unit();
    if (width <= 0) return range[0];
    if (current === null) return range[0] + u * width;
    const lo = Math.max(range[0], current - jump * width);
    const hi = Math.min(range[1], current + jump * width);
    return lo + u * (hi - lo);
  }

  get trafficRatesText(): string {
    if (!this._traffic.enabled) return "";
    const part = (label: string, rate: number, target: number) => {
      const arrow = target - rate > 0.5 ? " ↑" : target - rate < -0.5 ? " ↓" : "";
      return `${label} ${round(rate)}/h${arrow}`;
    };
    return part("ARR", this.arrivalRatePerHour, this.arrivalTargetPerHour) + "  " +
      part("DEP", this.departureRatePerHour, this.departureTargetPerHour);
  }

  private takenCallsigns(): Set<string> {
    return new Set(this.aircraft.map((a) => a.callsign));
  }

  private spawnArrival(): "spawned" | "blocked" | "impossible" {
    const airport = this.airport;
    if (!airport) return "impossible";
    const stars = airport.procedures.filter((p) => p.kind === "star" && p.legs.length >= 2 && this.isAvailable(p));
    const eligible = eligibleTypes(this._traffic);
    if (eligible.length === 0) return "impossible";
    const type = pick(eligible.map((t) => [t, t.share] as [AircraftType, number]), this.trafficRng.unit());
    if (stars.length === 0) return this.spawnFeederArrival(type);
    const first = this.trafficRng.below(stars.length);
    for (let k = 0; k < stars.length; k++) {
      const star = stars[(first + k) % stars.length];
      const points = this.routePoints(star.legs);
      if (points.length !== star.legs.length) continue;
      const entry = this.areaEntry(points);
      if (!entry) continue;
      const leg = star.legs[entry.next];
      let altitude = leg.altitude ? (leg.altitude.upperFeet ?? leg.altitude.feet) : 11000;
      altitude = Math.min(altitude, this.areaCeilingFt);
      altitude = Math.floor(altitude / 1000) * 1000;
      altitude = Math.max(Math.max(4000, this.levelFloorFt), Math.min(altitude, type.ceilingFt - 1000));
      const crowded = this.aircraft.some((o) => hypot(o.eastNM - entry.east, o.northNM - entry.north) < 7 && Math.abs(o.altitudeFt - altitude) < 3000);
      if (crowded) continue;
      let speed = leg.maxSpeedKt ?? (altitude > 10000 ? 280 : 250);
      speed = Math.max(type.minSpeedKt + 20, Math.min(speed, type.maxSpeedKt));
      const callsign = makeCallsign(type, airport.country, this.trafficRng, this.takenCallsigns());
      if (this.place(callsign, star, points, entry.east, entry.north, entry.next, altitude, speed, type, false)) {
        const ac = this.aircraft[this.aircraft.length - 1];
        this.log("pilot", P.approachCheckIn(ac, this.approachFacility, Math.trunc(altitude), this.transitionAltitudeFt), { callsign });
        return "spawned";
      }
    }
    return "blocked";
  }

  get fieldElevationFt(): number {
    const a = this.airport;
    if (!a) return 0;
    return a.elevationFt ?? (a.runways.length ? Math.max(...a.runways.map((r) => r.thresholdElevationFt)) : 0);
  }
  get approachLevelFloorFt(): number {
    return CommandLimits.approachFloorFt(this.fieldElevationFt);
  }
  get levelFloorFt(): number {
    return CommandLimits.floorFt(this.fieldElevationFt);
  }

  randomArrivalIdentity(): { callsign: string; type: AircraftType } {
    let pool = eligibleTypes(this._traffic);
    if (pool.length === 0) pool = AIRCRAFT_TYPES.filter((t) => t.canFlyIFR);
    const type = pick(pool.map((t) => [t, t.share] as [AircraftType, number]), this.trafficRng.unit());
    const callsign = makeCallsign(type, this.airport?.country, this.trafficRng, this.takenCallsigns());
    return { callsign, type };
  }

  feederFixes(): RoutePoint[] {
    const airport = this.airport;
    if (!airport) return [];
    const fixes = (procs: Procedure[]) => {
      const seen = new Set<string>();
      const out: RoutePoint[] = [];
      for (const p of procs) {
        const leg = p.legs[0];
        if (!leg) continue;
        const point = this.routePoints([leg])[0];
        if (!point) continue;
        const d = hypot(point.eastNM, point.northNM);
        if (d < 5 || d >= this.areaRadiusNM - 3 || seen.has(point.id)) continue;
        seen.add(point.id);
        out.push({ id: point.id, eastNM: point.eastNM, northNM: point.northNM });
      }
      return out;
    };
    const approaches = airport.procedures.filter((p) => p.kind === "approach");
    const open = fixes(approaches.filter((p) => this.isAvailable(p)));
    return open.length === 0 ? fixes(approaches) : open;
  }

  private spawnFeederArrival(type: AircraftType): "spawned" | "blocked" | "impossible" {
    const airport = this.airport;
    if (!airport) return "impossible";
    const fixes = this.feederFixes();
    if (fixes.length === 0) return "impossible";
    let altitude = Math.min(11000, this.areaCeilingFt);
    altitude = Math.floor(altitude / 1000) * 1000;
    altitude = Math.max(Math.max(4000, this.levelFloorFt), Math.min(altitude, type.ceilingFt - 1000));
    const first = this.trafficRng.below(fixes.length);
    for (let k = 0; k < fixes.length; k++) {
      const fix = fixes[(first + k) % fixes.length];
      const bearing = bearingDeg(fix.eastNM, fix.northNM) + (this.trafficRng.unit() * 60 - 30);
      const entry = LocalProjection.offset(bearing, this.areaRadiusNM);
      const crowded = this.aircraft.some((o) => hypot(o.eastNM - entry.east, o.northNM - entry.north) < 7 && Math.abs(o.altitudeFt - altitude) < 3000);
      if (crowded) continue;
      const speed = Math.max(type.minSpeedKt + 20, Math.min(250, type.maxSpeedKt));
      const callsign = makeCallsign(type, airport.country, this.trafficRng, this.takenCallsigns());
      const proc: Procedure = { id: `DCT ${fix.id}`, kind: "star", runways: [], legs: [{ fixId: fix.id }] };
      if (this.place(callsign, proc, [fix], entry.east, entry.north, 0, altitude, speed, type, false)) {
        const ac = this.aircraft[this.aircraft.length - 1];
        this.log("pilot", P.approachCheckIn(ac, this.approachFacility, Math.trunc(altitude), this.transitionAltitudeFt), { callsign });
        return "spawned";
      }
    }
    return "blocked";
  }

  private placeFeederStartTraffic(target: number): number {
    const fixes = this.feederFixes();
    if (fixes.length === 0) return 0;
    const roll = (n: number) => this.trafficRng.below(Math.max(n, 1));
    let placed = 0, attempts = 0;
    while (placed < target && attempts < target * 10) {
      attempts++;
      const fix = fixes[roll(fixes.length)];
      const bearing = bearingDeg(fix.eastNM, fix.northNM) + (roll(61) - 30);
      const fixDistance = hypot(fix.eastNM, fix.northNM);
      const nearest = fixDistance + 5, farthest = this.areaRadiusNM - 3;
      if (farthest <= nearest) continue;
      const distance = nearest + this.trafficRng.unit() * (farthest - nearest);
      const start = LocalProjection.offset(bearing, distance);
      const id = this.randomArrivalIdentity();
      const level = Math.max(Math.min(5000 + roll(11) * 500, id.type.ceilingFt - 1000, this.areaCeilingFt), this.levelFloorFt);
      const speed = Math.max(id.type.minSpeedKt + 20, Math.min(240 - roll(3) * 10, id.type.maxSpeedKt));
      const proc: Procedure = { id: `DCT ${fix.id}`, kind: "star", runways: [], legs: [{ fixId: fix.id }] };
      if (!this.place(id.callsign, proc, [fix], start.east, start.north, 0, level, speed, id.type, true)) continue;
      if (evaluateSeparation(this.aircraft, this.wind).length === 0) placed++;
      else this.removeLastPlaced();
    }
    return placed;
  }

  private removeLastPlaced(): void {
    const ac = this.aircraft.pop();
    if (ac) this.arrivalStart.delete(ac.callsign);
  }

  /** Arrivals already in the sector when an airport is loaded. */
  placeStartTraffic(counts: [number, number] = [2, 7]): number {
    const airport = this.airport;
    if (!airport) return 0;
    const stars = airport.procedures.filter((p) => p.kind === "star" && p.legs.length >= 4 && this.isAvailable(p));
    const roll = (n: number) => this.trafficRng.below(Math.max(n, 1));
    const hasStars = airport.procedures.some((p) => p.kind === "star");
    const span = counts[1] - counts[0] + 1;
    if (!hasStars) return this.placeFeederStartTraffic(counts[0] + roll(span));
    if (stars.length === 0) return 0;
    const target = counts[0] + roll(span);
    let placed = 0, attempts = 0;
    while (placed < target && attempts < target * 10) {
      attempts++;
      const proc = stars[roll(stars.length)];
      const index = 1 + roll(proc.legs.length - 2);
      const leg = proc.legs[index];
      const p = this.routePoints([leg])[0];
      if (p && hypot(p.eastNM, p.northNM) > this.areaRadiusNM) continue;
      const id = this.randomArrivalIdentity();
      let altitude = 9000 + (roll(6) - 2) * 500;
      const c = leg.altitude;
      if (c) {
        switch (c.kind) {
          case "at": altitude = c.feet; break;
          case "atOrBelow": altitude = c.feet - roll(4) * 500; break;
          case "atOrAbove": altitude = c.feet + roll(4) * 500; break;
          case "between": {
            const upper = Math.max(c.upperFeet ?? c.feet, c.feet);
            altitude = c.feet + roll(Math.trunc((upper - c.feet) / 500) + 1) * 500;
            break;
          }
        }
      }
      const level = Math.max(Math.min(altitude, id.type.ceilingFt - 1000, this.areaCeilingFt), this.levelFloorFt);
      const base = leg.maxSpeedKt ?? 240;
      const speed = Math.max(id.type.minSpeedKt + 20, Math.min(base - roll(3) * 10, id.type.maxSpeedKt));
      if (!this.spawnOnProcedure(id.callsign, proc.id, index, level, speed, id.type, true)) continue;
      if (evaluateSeparation(this.aircraft, this.wind).length === 0) placed++;
      else this.removeLastPlaced();
    }
    return placed;
  }

  // MARK: Departures

  static expectedLevel(callsign: string, type: AircraftType, initialFt: number): number {
    const ceiling = type.ceilingFt - 1000;
    const options = [22000, 28000, 34000, 36000].filter((x) => x <= ceiling);
    if (options.length === 0) return Math.max(initialFt, Math.trunc(ceiling / 1000) * 1000);
    let sum = 0;
    for (const ch of callsign) sum += ch.codePointAt(0)!;
    return Math.max(initialFt, options[sum % options.length]);
  }

  private sids(runway: string): Procedure[] {
    return this.airport?.procedures.filter((p) => p.kind === "sid" && p.runways.includes(runway) && p.legs.length >= 2) ?? [];
  }

  private spawnDeparture(): void {
    const airport = this.airport, projection = this.projection;
    if (!airport || !projection) return;
    const eligible = eligibleTypes(this._traffic);
    const open = this.openRunways;
    const runways = airport.runways.filter((r) => open.has(r.id));
    if (eligible.length === 0 || runways.length === 0) return;
    const runway = runways[this.trafficRng.below(runways.length)];
    const waiting = this.aircraft.filter((a) => a.departure?.runway === runway.id && a.groundPhase === "holdingShort").length;
    if (waiting >= 3) return;
    const type = pick(eligible.map((t) => [t, t.share] as [AircraftType, number]), this.trafficRng.unit());
    const options = this.sids(runway.id);
    const sid = options.length === 0 ? null : options[this.trafficRng.below(options.length)];
    const points = sid ? this.routePoints(sid.legs) : [];
    if (sid && points.length === 0) return;
    const callsign = makeCallsign(type, airport.country, this.trafficRng, this.takenCallsigns());
    const threshold = projection.nm(runway.thresholdLat, runway.thresholdLon);
    const back = LocalProjection.offset(runway.trueBearingDeg + 180, 0.1 + 0.05 * waiting);
    const elevation = runway.thresholdElevationFt;
    const ac = new Aircraft(callsign, threshold.east + back.east, threshold.north + back.north, runway.trueBearingDeg, elevation, 0);
    ac.applyType(type);
    ac.targetSpeedKt = 0;
    ac.route = points;
    ac.routeIndex = 0;
    ac.procedureId = sid?.id ?? null;
    const initial = Math.min(type.ceilingFt - 1000, Math.max(3000, Math.ceil((elevation + 2500) / 1000) * 1000));
    const rotate = type.approachSpeedKt + (type.category === "light" || type.category === "helicopter" ? 0 : 10);
    const expected = Simulation.expectedLevel(callsign, type, initial);
    const handoffAt = Math.min(expected, Math.max(4000, Math.ceil((elevation + 4000) / 1000) * 1000));
    ac.departure = {
      runway: runway.id, sid: sid?.id ?? "", initialAltitudeFt: initial, fieldElevationFt: elevation, rotateSpeedKt: rotate,
      checkedIn: false, handedOff: false, vectored: false, exitFix: null, expectedLevelFt: expected,
      handoffAltitudeFt: Math.max(initial, handoffAt),
    };
    ac.departure.exitFix = sid?.legs[sid.legs.length - 1]?.fixId ?? this.pickExitFix(runway);
    ac.groundPhase = "holdingShort";
    ac.levelFloorFt = this.levelFloorFt;
    ac.approachLevelFloorFt = this.approachLevelFloorFt;
    this.aircraft.push(ac);
    this.log("pilot", `Holding point runway ${P.spokenRunway(runway.id)}, ready for departure, ${P.spokenCallsign(ac)}`, { callsign });
  }

  private pickExitFix(runway: Runway): string | null {
    const finalBearing = runway.trueBearingDeg + 180;
    const all = [...this.fixIndex.entries()].map(([id, p]) => ({ id, east: p.east, north: p.north }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const candidates = all.filter((f) => {
      const d = hypot(f.east, f.north);
      const b = bearingDeg(f.east, f.north);
      return d >= this.areaRadiusNM * 0.6 && d <= this.areaRadiusNM * 1.3 && Math.abs(signedTurn(finalBearing, b)) > 45;
    });
    if (candidates.length > 0) return candidates[this.trafficRng.below(candidates.length)].id;
    let best: (typeof all)[number] | null = null;
    for (const f of all) if (!best || hypot(f.east, f.north) > hypot(best.east, best.north)) best = f;
    return best?.id ?? null;
  }

  resumeRoute(ac: Aircraft): RoutePoint[] {
    let points: RoutePoint[] = [];
    const id = ac.procedureId;
    if (id) {
      const proc = this.airport?.procedures.find((p) => p.id === id);
      if (proc) points = this.routePoints(proc.legs);
      else if (id.startsWith("DCT ")) points = this.routePoints([{ fixId: id.slice(4) }]);
    }
    const exit = ac.departure?.exitFix;
    if (exit && points[points.length - 1]?.id !== exit) points = points.concat(this.routePoints([{ fixId: exit }]));
    if (points.length <= 1) return points;
    let best = 1, bestDistance = Infinity;
    for (let k = 0; k < points.length - 1; k++) {
      const a = points[k], b = points[k + 1];
      const dx = b.eastNM - a.eastNM, dy = b.northNM - a.northNM;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((ac.eastNM - a.eastNM) * dx + (ac.northNM - a.northNM) * dy) / l2)) : 0;
      const d = hypot(ac.eastNM - (a.eastNM + t * dx), ac.northNM - (a.northNM + t * dy));
      if (d < bestDistance) { bestDistance = d; best = k + 1; }
    }
    return points.slice(best);
  }

  runwayOccupied(runway: string, excluding: string | null = null): boolean {
    const ends = new Set([runway, oppositeRunway(runway)]);
    return this.aircraft.some((ac) => {
      const d = ac.departure;
      if (ac.callsign === excluding || !d || !ends.has(d.runway)) return false;
      if (ac.groundPhase) return ac.groundPhase === "linedUp" || ac.groundPhase === "takeoffRoll";
      return ac.altitudeFt < d.fieldElevationFt + 150;
    });
  }

  runwayUses(landingNM = 1.0): Map<string, RunwayUse> {
    const uses = new Map<string, RunwayUse>();
    for (const ac of this.aircraft) {
      const d = ac.departure;
      if (d) {
        const busy = ac.groundPhase ? ac.groundPhase === "linedUp" || ac.groundPhase === "takeoffRoll" : ac.altitudeFt < d.fieldElevationFt + 150;
        if (busy) uses.set(d.runway, { kind: "departing", callsign: ac.callsign });
      } else if (ac.approach && !ac.landed) {
        const app = ac.approach;
        const along = app.ils.position(ac.eastNM, ac.northNM).along;
        if (along > 0 && along <= landingNM) {
          const cur = uses.get(app.ils.runwayId);
          if (cur?.kind === "landing" && cur.nm <= along) continue;
          if (cur?.kind === "departing") continue;
          uses.set(app.ils.runwayId, { kind: "landing", callsign: ac.callsign, nm: along });
        }
      }
    }
    return uses;
  }

  private arrivalOnFinal(runway: string, limit: number): { callsign: string; nm: number } | null {
    const ends = new Set([runway, oppositeRunway(runway)]);
    let best: { callsign: string; nm: number } | null = null;
    for (const ac of this.aircraft) {
      const app = ac.approach;
      if (!app || !ends.has(app.ils.runwayId)) continue;
      const along = app.ils.position(ac.eastNM, ac.northNM).along;
      if (along > 0 && along <= limit && along < (best?.nm ?? Infinity)) best = { callsign: ac.callsign, nm: along };
    }
    return best;
  }

  private moveToThreshold(ac: Aircraft): void {
    const d = ac.departure;
    if (!this.projection || !d) return;
    const runway = this.runway(d.runway);
    if (!runway) return;
    const p = this.projection.nm(runway.thresholdLat, runway.thresholdLon);
    ac.eastNM = p.east;
    ac.northNM = p.north;
  }

  spawnOnProcedure(callsign: string, id: string, startIndex: number, altitudeFt: number, speedKt: number,
                   type: AircraftType | null, requireClear: boolean): boolean {
    const proc = this.airport?.procedures.find((p) => p.id === id);
    if (!proc) return false;
    const points = this.routePoints(proc.legs);
    if (startIndex < 0 || startIndex >= points.length) return false;
    const start = points[startIndex];
    return this.place(callsign, proc, points, start.eastNM, start.northNM, startIndex + 1, altitudeFt, speedKt, type, requireClear);
  }

  get approachFacility(): string {
    const a = this.airport;
    return a ? `${a.city ?? a.name} Approach` : "Approach";
  }

  areaEntry(points: RoutePoint[]): { next: number; east: number; north: number } | null {
    const r = this.areaRadiusNM;
    const firstInside = points.findIndex((p) => hypot(p.eastNM, p.northNM) <= r);
    if (firstInside < 0) return null;
    if (firstInside === 0) return { next: 1, east: points[0].eastNM, north: points[0].northNM };
    const a = points[firstInside - 1], b = points[firstInside];
    const dx = b.eastNM - a.eastNM, dy = b.northNM - a.northNM;
    const qa = dx * dx + dy * dy;
    if (qa <= 0) return { next: firstInside, east: b.eastNM, north: b.northNM };
    const qb = 2 * (a.eastNM * dx + a.northNM * dy);
    const qc = a.eastNM * a.eastNM + a.northNM * a.northNM - r * r;
    const disc = Math.max(0, qb * qb - 4 * qa * qc);
    const t = Math.min(1, Math.max(0, (-qb - Math.sqrt(disc)) / (2 * qa)));
    return { next: firstInside, east: a.eastNM + t * dx, north: a.northNM + t * dy };
  }

  private place(callsign: string, proc: Procedure, points: RoutePoint[], east: number, north: number, nextIndex: number,
                altitudeFt: number, speedKt: number, type: AircraftType | null, requireClear: boolean): boolean {
    if (requireClear) {
      for (const o of this.aircraft) {
        if (hypot(o.eastNM - east, o.northNM - north) < 10 && Math.abs(o.altitudeFt - altitudeFt) < 2000) return false;
      }
    }
    let heading = 0;
    if (nextIndex < points.length) {
      const next = points[nextIndex];
      heading = bearingDeg(next.eastNM - east, next.northNM - north);
    }
    const ac = new Aircraft(callsign, east, north, heading, altitudeFt, speedKt);
    if (type) ac.applyType(type);
    ac.route = points;
    ac.procedureId = proc.id;
    ac.routeIndex = Math.min(nextIndex, points.length);
    ac.levelFloorFt = this.levelFloorFt;
    ac.approachLevelFloorFt = this.approachLevelFloorFt;
    ac.plannedEvent = this.planEvent();
    this.aircraft.push(ac);
    this.arrivalStart.set(callsign, { tick: this.tickCount, east, north });
    return true;
  }

  private planEvent(): PlannedEvent | null {
    const e = this.events;
    if (e.pilotGoAroundPercent + e.windshearPercent + e.emergencyPercent <= 0) return null;
    const roll = this.eventRng.unit() * 100;
    const detail = this.eventRng.unit();
    if (roll < e.pilotGoAroundPercent) {
      const reasons = ["pilot's decision, not stable", "pilot's decision, no visual references", "pilot's decision, not comfortable with the approach"];
      return { kind: "pilotGoAround", reason: reasons[this.eventRng.below(reasons.length)], triggerNM: 1.0 + detail * 2.0 };
    }
    if (roll < e.pilotGoAroundPercent + e.windshearPercent) return { kind: "windshear", triggerNM: 1.5 + detail * 2.5 };
    if (roll < e.pilotGoAroundPercent + e.windshearPercent + e.emergencyPercent) {
      const kind = EMERGENCY_KINDS[this.eventRng.below(EMERGENCY_KINDS.length)];
      return { kind: "emergency", emergency: kind, atTick: this.tickCount + 60 + Math.trunc(detail * 240) };
    }
    return null;
  }

  private processPlannedEvent(ac: Aircraft): void {
    const plan = ac.plannedEvent;
    if (!plan) return;
    const alongFinal = (): number | null => {
      const app = ac.approach;
      if (!app || app.phase !== "glideslope" || ac.departure) return null;
      return app.ils.position(ac.eastNM, ac.northNM).along;
    };
    switch (plan.kind) {
      case "pilotGoAround": {
        const along = alongFinal();
        if (along === null || along <= 0 || along > plan.triggerNM) return;
        ac.plannedEvent = null;
        ac.abortApproach(plan.reason);
        break;
      }
      case "windshear": {
        const along = alongFinal();
        if (along === null || along <= 0 || along > plan.triggerNM) return;
        ac.plannedEvent = null;
        this.log("pilot", `Windshear alert, ${P.spokenCallsign(ac)}`, { callsign: ac.callsign, tag: "WSHEAR" });
        ac.abortApproach("windshear on final");
        break;
      }
      case "emergency": {
        if (this.tickCount < plan.atTick || ac.landed) return;
        ac.plannedEvent = null;
        ac.emergency = plan.emergency;
        const word = urgencyWord(plan.emergency);
        this.log("pilot", `${word} ${word} ${word}, ${P.spokenCallsign(ac)}, ${emergencyPhrase(plan.emergency)}, ${emergencyRequest(plan.emergency)}`,
          { callsign: ac.callsign, tag: word === "MAYDAY" ? "MAYDAY" : "PAN PAN" });
        this.log("system", `${ac.callsign} declares an emergency: ${emergencyPhrase(plan.emergency)}`, { callsign: ac.callsign, tag: "EMERG" });
        break;
      }
    }
  }

  private checkInterceptStall(ac: Aircraft): void {
    const app = ac.approach;
    const onRoute = ac.routeIndex < ac.route.length;
    const block = ac.captureBlocker();
    if (!app || app.phase !== "intercepting" || ac.departure || onRoute || !block) {
      this.interceptStall.delete(ac.callsign);
      if (!ac.approach) this.interceptCalled.delete(ac.callsign);
      return;
    }
    const waited = (this.interceptStall.get(ac.callsign) ?? 0) + 1;
    this.interceptStall.set(ac.callsign, waited);
    if (waited < Simulation.interceptStallCallSeconds || this.interceptCalled.has(ac.callsign)) return;
    this.interceptCalled.add(ac.callsign);
    const runway = P.spokenRunway(app.ils.runwayId);
    const along = app.ils.position(ac.eastNM, ac.northNM).along;
    let reason: string;
    if (block.kind === "insideGate") reason = "we're too close to make the approach, request vectors for another";
    else if (block.kind === "tooFar") reason = `we're ${round(along)} miles out, we'll need a vector`;
    else {
      const h = round(ac.headingDeg);
      reason = `we're heading ${P.spokenDigits(String(h === 0 ? 360 : h).padStart(3, "0"))}, we'll need a vector`;
    }
    this.log("pilot", `Unable to intercept the localiser runway ${runway}, ${reason}, ${P.spokenCallsign(ac)}`, { callsign: ac.callsign, tag: "UNABLE" });
  }

  private checkAboveGlidepath(ac: Aircraft): void {
    const app = ac.approach;
    if (!app || app.phase !== "localiser" || ac.departure) {
      this.highStall.delete(ac.callsign);
      if (!ac.approach) this.highCalled.delete(ac.callsign);
      return;
    }
    const p = app.ils.position(ac.eastNM, ac.northNM);
    const beam = app.ils.glidepathAltitudeFt(Math.max(p.along, 0));
    if (!(p.along > Aircraft.stableGateNM + 0.5 && ac.altitudeFt > beam + 300)) {
      this.highStall.delete(ac.callsign);
      return;
    }
    const waited = (this.highStall.get(ac.callsign) ?? 0) + 1;
    this.highStall.set(ac.callsign, waited);
    if (waited < Simulation.highCallSeconds || this.highCalled.has(ac.callsign)) return;
    this.highCalled.add(ac.callsign);
    this.log("pilot", `We're above the glidepath, request lower, ${P.spokenCallsign(ac)}`, { callsign: ac.callsign, tag: "HIGH" });
  }

  // MARK: Commands

  /** An instruction from the player cancels a macro running on that aircraft: the player has taken over. */
  issue(issued: IssuedCommand): IssueResult {
    if (this.macroRuns.has(issued.callsign)) this.stopMacro(issued.callsign, "manual instruction", false);
    const result = this.issueChecked(issued);
    if (result.accepted) {
      this.instructionCounts.set(issued.callsign, (this.instructionCounts.get(issued.callsign) ?? 0) + 1);
      this.lastInstructionTick.set(issued.callsign, this.tickCount);
      this.score.instructions++;
    } else if (this.aircraft.some((a) => a.callsign === issued.callsign)) {
      this.addScore("refused", { callsign: issued.callsign });
    }
    return result;
  }

  /** Sends a chain; its controller calls share one command-bar code, shown on the first. */
  issueChain(chain: IssuedCommand[]): IssueResult[] {
    if (chain.length === 0) return [];
    const startID = this.nextMessageID - 1;
    const results = chain.map((c) => this.issue(c));
    const sent = chain.filter((_, i) => results[i].accepted).map((c) => c.command);
    if (sent.length > 1) this.labelChain(chain[0].callsign, startID, chainCode(chain[0].callsign, sent));
    return results;
  }

  private issueChecked(input: IssuedCommand): IssueResult {
    const issued = { callsign: input.callsign, command: input.command };
    if (issued.command.k === "approach" && this.isVisualRunway(issued.command.runway)) {
      issued.command = { k: "visualApproach", runway: issued.command.runway };
    }
    const ac = this.aircraft.find((a) => a.callsign === issued.callsign);
    if (!ac) return { accepted: false, reason: "no such aircraft" };
    if (issued.command.k === "direct" && issued.command.fix === EXIT_FIX_TOKEN) {
      const exit = ac.departure?.exitFix;
      if (!exit) return { accepted: false, reason: `${ac.callsign} has no exit fix` };
      issued.command = { k: "direct", fix: exit };
    }
    const refusal = commandRefusal(issued.command, ac);
    if (refusal) return { accepted: false, reason: refusal };
    const c = issued.command;
    switch (c.k) {
      case "approach":
        if (!this.ilsGeometry(c.runway)) return { accepted: false, reason: `no ILS data for runway ${c.runway}` };
        if (this.closedReason(c.runway)) return this.refuseClosed(c.runway, this.closedReason(c.runway)!, ac.callsign);
        break;
      case "visualApproach":
        if (!this.approachGeometry(c.runway)) return { accepted: false, reason: `no such runway ${c.runway}` };
        if (this.closedReason(c.runway)) return this.refuseClosed(c.runway, this.closedReason(c.runway)!, ac.callsign);
        break;
      case "direct":
        if (!this.fixIndex.has(c.fix)) return { accepted: false, reason: `unknown fix ${c.fix}` };
        break;
      case "resumeNavigation":
        if (this.resumeRoute(ac).length === 0) return { accepted: false, reason: `${ac.callsign} has no route to resume` };
        break;
      case "route": {
        const bad = c.fixes.find((f) => !this.fixIndex.has(f));
        if (bad) return { accepted: false, reason: `unknown fix ${bad}` };
        break;
      }
      case "cross":
        if (!this.fixIndex.has(c.fix)) return { accepted: false, reason: `unknown fix ${c.fix}` };
        if (!this.fixWillBeOnRoute(ac, c.fix)) return { accepted: false, reason: `${c.fix} is not on the route` };
        break;
      case "lineUp":
      case "takeoff": {
        const runway = ac.departure?.runway;
        if (!runway) return { accepted: false, reason: "not a departure" };
        const closed = this.closedReason(runway);
        if (closed) return this.refuseClosed(runway, closed, ac.callsign);
        if (this.runwayOccupied(runway, ac.callsign)) return this.refuseRunway(`runway ${runway} is occupied`, ac.callsign);
        if (c.k === "takeoff") {
          const t = this.arrivalOnFinal(runway, 4);
          if (t) return this.refuseRunway(`${t.callsign} is on final, ${t.nm.toFixed(1)} NM`, ac.callsign);
        }
        break;
      }
      case "joinApproach": {
        const proc = this.airport?.procedures.find((p) => p.id === c.procedure && p.kind === "approach");
        if (!proc) return { accepted: false, reason: `unknown approach ${c.procedure}` };
        if (!this.approachGeometryFor(proc)) return { accepted: false, reason: `no ${spokenApproachType(finalApproachType(proc))} data for runway ${c.runway}` };
        const closed = this.closedReason(c.runway);
        if (closed) return this.refuseClosed(c.runway, closed, ac.callsign);
        break;
      }
      default:
        break;
    }
    let call = P.controllerCall(c, ac, this.transitionAltitudeFt);
    if (c.k === "takeoff") call = P.takeoffCall(ac, this.wind, this.transitionAltitudeFt);
    this.log("controller", call, { callsign: ac.callsign, code: chainCode(ac.callsign, [c]) });
    let delay = 3 + this.rng.below(4);
    let latest = -Infinity;
    for (const p of this.pending) if (p.callsign === ac.callsign) latest = Math.max(latest, p.executeAtTick);
    if (latest > -Infinity) delay = Math.max(delay, latest - this.tickCount);
    this.pending.push({ executeAtTick: this.tickCount + delay, callsign: ac.callsign, command: c, readback: P.readback(c, ac, this.transitionAltitudeFt) });
    const list = this.commandHistory.get(ac.callsign) ?? [];
    list.push({ id: this.nextRecordID++, callsign: ac.callsign, command: c, issuedTick: this.tickCount, executeAtTick: this.tickCount + delay });
    if (list.length > Simulation.historyLimit) list.splice(0, list.length - Simulation.historyLimit);
    this.commandHistory.set(ac.callsign, list);
    return { accepted: true, delaySeconds: delay };
  }

  /** True while an instruction to this aircraft is still waiting for the pilot. */
  hasPending(callsign: string): boolean {
    return this.pending.some((p) => p.callsign === callsign);
  }

  private fixWillBeOnRoute(ac: Aircraft, fix: string): boolean {
    let latest: string[] | null = null;
    for (const p of this.pending) {
      if (p.callsign !== ac.callsign) continue;
      const c = p.command;
      if (c.k === "direct") latest = [c.fix];
      else if (c.k === "route") latest = c.fixes;
      else if (c.k === "joinApproach") latest = this.airport?.procedures.find((x) => x.id === c.procedure)?.legs.map((l) => l.fixId) ?? [];
    }
    if (latest) return latest.includes(fix);
    return ac.route.slice(ac.routeIndex).some((p) => p.id === fix);
  }

  private refuseRunway(text: string, callsign: string): IssueResult {
    this.log("system", "Unable: " + text, { callsign, tag: "REFUSED" });
    return { accepted: false, reason: text };
  }

  private refuseClosed(runway: string, reason: string, callsign: string): IssueResult {
    const text = `runway ${runway} is closed: ${reason}`;
    this.log("system", "Unable: " + text, { callsign, tag: "REFUSED" });
    return { accepted: false, reason: text };
  }

  private updateConflicts(): void {
    this.conflicts = evaluateSeparation(this.aircraft, this.wind);
    const current = new Map<string, Conflict["kind"]>();
    for (const c of this.conflicts) {
      current.set(c.id, c.kind);
      const withTower = this.isWithTower(c.first) && this.isWithTower(c.second);
      const before = this.alertedKinds.get(c.id);
      if (before === undefined || (before === "predicted" && c.kind === "loss")) {
        if (c.kind === "predicted") {
          if (!withTower) {
            this.log("system", `CONFLICT ${c.first} / ${c.second}: separation lost in ${c.secondsToLoss} s on current tracks`, { tag: "CONFLICT" });
            this.addScore("conflictAlert", { detail: `${c.first} / ${c.second}` });
          }
        } else if (withTower) {
          this.log("system", `${c.first} / ${c.second} closer than ${Math.trunc(SeparationMinima.lateralNM)} NM on final, both with the tower (not counted)`);
        } else {
          this.lossOfSeparationCount++;
          this.log("system", `LOSS OF SEPARATION ${c.first} / ${c.second}: ${c.lateralNM.toFixed(1)} NM, ${round(c.verticalFt)} ft`, { tag: "LOSS" });
          this.score.losses++;
          this.addScore("lossOfSeparation", { detail: `${c.first} / ${c.second}` });
        }
      }
      if (c.kind === "loss" && !withTower) {
        const s = (this.lossSeconds.get(c.id) ?? 0) + 1;
        this.lossSeconds.set(c.id, s);
        if (s % ScoreRules.lossStepSeconds === 0) this.addScore("lossContinues", { detail: `${c.first} / ${c.second}, ${s} s` });
      }
    }
    for (const k of [...this.lossSeconds.keys()]) if (current.get(k) !== "loss") this.lossSeconds.delete(k);
    this.alertedKinds = current;
  }

  private isWithTower(callsign: string): boolean {
    return this.aircraft.find((a) => a.callsign === callsign)?.handedToTower ?? false;
  }

  labelChain(callsign: string, afterMessageID: number, code: string): void {
    const calls = this.radioLog.filter((m) => m.id > afterMessageID && m.speaker === "controller" && m.callsign === callsign);
    if (calls.length === 0) return;
    for (const m of calls) m.code = undefined;
    calls[0].code = code;
  }

  private log(speaker: Speaker, text: string, opts: { callsign?: string; tag?: RadioTag; code?: string } = {}): void {
    this.radioLog.push({ id: this.nextMessageID++, tick: this.tickCount, speaker, text, ...opts });
    if (this.radioLog.length > 300) this.radioLog.splice(0, this.radioLog.length - 300);
  }

  // MARK: Score

  private addScore(kind: ScoreKind, opts: { points?: number; callsign?: string; detail?: string } = {}): void {
    if (this.score.endTick !== null) return;
    const value = opts.points ?? ScoreRules.points[kind] ?? 0;
    const e = {
      id: this.nextScoreID++, tick: this.tickCount, kind, points: value, callsign: opts.callsign ?? null,
      detail: opts.detail || opts.callsign || "",
    };
    this.score.add(e);
    if (Math.abs(value) >= ScoreRules.announceAtPoints) this.log("system", scoreEventText(e), { callsign: opts.callsign });
  }

  private scoreHandoff(ac: Aircraft): void {
    const d = ac.departure;
    if (d) {
      this.score.departuresHandled++;
      this.addScore("departureHandoff", { callsign: ac.callsign });
      if (round(ac.targetAltitudeFt) >= d.expectedLevelFt) this.addScore("departureAtPlanLevel", { callsign: ac.callsign });
      const exit = d.exitFix;
      const p = exit ? this.fixIndex.get(exit) : undefined;
      if (exit && p) {
        const onRoute = ac.route.slice(ac.routeIndex).some((x) => x.id === exit);
        const toExit = bearingDeg(p.east - ac.eastNM, p.north - ac.northNM);
        const off = Math.abs(signedTurn(ac.headingDeg, toExit));
        const close = hypot(p.east - ac.eastNM, p.north - ac.northNM) < 3;
        if (onRoute || close || off <= ScoreRules.exitAlignedDeg) {
          this.addScore("exitDirection", { callsign: ac.callsign, detail: `${ac.callsign} towards ${exit}` });
        } else if (off > ScoreRules.exitWrongWayDeg) {
          this.addScore("exitWrongWay", { callsign: ac.callsign, detail: `${ac.callsign}, ${round(off)}° off ${exit}` });
        }
      }
      return;
    }
    this.score.arrivalsHandled++;
    this.addScore("arrivalHandoff", { callsign: ac.callsign });
    const start = this.arrivalStart.get(ac.callsign);
    const app = ac.approach;
    if (!start || !app) return;
    const distance = hypot(start.east - app.ils.thresholdEastNM, start.north - app.ils.thresholdNorthNM);
    const clean = ScoreRules.cleanSeconds(distance);
    const actual = this.tickCount - start.tick;
    const bonus = ScoreRules.efficiencyBonus(actual, clean);
    this.score.arrivals.push({ callsign: ac.callsign, actualSeconds: actual, cleanSeconds: round(clean), bonus, instructions: this.instructionCounts.get(ac.callsign) ?? 0 });
    if (bonus > 0) this.addScore("efficiency", { points: bonus, callsign: ac.callsign });
  }

  private updateScoreEachSecond(): void {
    if (this.score.endTick !== null) return;
    for (const ac of this.aircraft) {
      if (ac.groundPhase === "holdingShort" || ac.groundPhase === "linedUp") {
        const since = this.holdingSince.get(ac.callsign) ?? this.tickCount;
        this.holdingSince.set(ac.callsign, since);
        const waited = this.tickCount - since;
        if (waited > ScoreRules.departureGraceSeconds && (waited - ScoreRules.departureGraceSeconds) % 60 === 0) {
          this.addScore("departureDelay", { callsign: ac.callsign });
        }
      } else {
        this.holdingSince.delete(ac.callsign);
      }
      if (ac.onRunwayHeading && !ac.isOnGround && !this.runwayHeadingPenalised.has(ac.callsign) &&
        hypot(ac.eastNM, ac.northNM) > ScoreRules.runwayHeadingLimitNM) {
        this.runwayHeadingPenalised.add(ac.callsign);
        this.addScore("runwayHeadingUnvectored", { callsign: ac.callsign });
      }
      if (ac.emergency && !ac.handedToTower && !this.emergencyChecked.has(ac.callsign)) {
        const since = this.emergencySince.get(ac.callsign) ?? this.tickCount;
        this.emergencySince.set(ac.callsign, since);
        if (this.tickCount - since >= ScoreRules.emergencyWaitSeconds) {
          this.emergencyChecked.add(ac.callsign);
          if ((this.lastInstructionTick.get(ac.callsign) ?? -1) < since) this.addScore("emergencyIgnored", { callsign: ac.callsign });
        }
      }
    }
    if (this._traffic.enabled) {
      this.rateSeconds++;
      this.rateSum += this.arrivalRatePerHour + this.departureRatePerHour;
    }
    if ((this.tickCount - this.score.startTick) % 60 === 0) {
      this.updateScoreMultiplier();
      this.score.samples.push({ minute: Math.trunc((this.tickCount - this.score.startTick) / 60), rawScore: this.score.raw,
        arrivalsPerHour: this.arrivalRatePerHour, departuresPerHour: this.departureRatePerHour });
    }
  }

  private updateScoreMultiplier(): void {
    this.score.multiplier = scoreMultiplier(this.rateSeconds > 0 ? this.rateSum / this.rateSeconds : null,
      isVariable(this._traffic), this._traffic.variation, this.events, this.weatherMode === "live", this.wind.isGusting);
  }

  endSession(): ScoreCard {
    if (this.score.endTick === null) {
      this.updateScoreMultiplier();
      const minute = Math.trunc((this.tickCount - this.score.startTick + 59) / 60);
      if (this.score.samples[this.score.samples.length - 1]?.minute !== minute) {
        this.score.samples.push({ minute, rawScore: this.score.raw, arrivalsPerHour: this.arrivalRatePerHour, departuresPerHour: this.departureRatePerHour });
      }
      this.score.endTick = this.tickCount;
    }
    return this.score;
  }

  resumeSession(): void {
    this.score.endTick = null;
  }

  // MARK: Macros

  /** Macros running now, by callsign. At most one per aircraft. */
  macroRuns = new Map<string, MacroRun>();
  /** A step that waits longer than this for its trigger stops the macro. */
  macroStepTimeoutSeconds = 300;

  /** Starts a macro on an aircraft, replacing any it was running. A first step without a trigger is sent at once.
   * Returns why the macro cannot run, or null. */
  assignMacro(macro: CompiledMacro, callsign: string): string | null {
    const ac = this.aircraft.find((a) => a.callsign === callsign);
    if (!ac) return "no such aircraft";
    if (ac.handedToTower) return `${callsign} is with the tower`;
    const phase = phaseOf(ac);
    if (phase !== macro.phase) {
      return `${macro.name} is a ${PHASE_LABEL[macro.phase].toLowerCase()} macro, ${callsign} is ${phase === "arrival" ? "an" : "a"} ${PHASE_LABEL[phase].toLowerCase()}`;
    }
    if (macro.steps.length === 0) return `${macro.name} has no steps`;
    if (this.macroRuns.has(callsign)) this.stopMacro(callsign, `replaced by ${macro.name}`, false);
    this.macroRuns.set(callsign, { macro, stepIndex: 0, stepStartTick: this.tickCount, lastTarget: this.currentTarget(ac) });
    this.log("system", `${callsign} macro ${macro.name} started`, { callsign });
    this.advanceMacro(callsign);
    return null;
  }

  /** Cancels the aircraft's macro (command bar `mac-`, ring). Returns false if it had none. */
  cancelMacro(callsign: string): boolean {
    if (!this.macroRuns.has(callsign)) return false;
    this.stopMacro(callsign, "cancelled", false);
    return true;
  }

  private stopMacro(callsign: string, reason: string, flagged: boolean): void {
    const run = this.macroRuns.get(callsign);
    if (!run) return;
    this.macroRuns.delete(callsign);
    this.log("system", `${callsign} macro ${run.macro.name} stopped: ${reason}`, { callsign, tag: flagged ? "M!" : undefined });
  }

  private currentTarget(ac: Aircraft): string | null {
    return ac.routeIndex < ac.route.length ? ac.route[ac.routeIndex].id : null;
  }

  private triggerFired(trigger: MacroTrigger | null, run: MacroRun, ac: Aircraft): boolean {
    if (!trigger) return true;
    const value = triggerHolds(trigger, ac);
    if (value !== null) return value;
    if (trigger.k !== "atFix") return false;
    // Passed: the fix was the route target last tick and no longer is, or the aircraft is over it.
    if (run.lastTarget === trigger.fix && this.currentTarget(ac) !== trigger.fix) return true;
    const p = this.fixIndex.get(trigger.fix);
    if (!p) return false;
    return hypot(ac.eastNM - p.east, ac.northNM - p.north) <= 1.0;
  }

  /** Sends the next step if its trigger has fired. At most one step per call, so each step is its own transmission. */
  private advanceMacro(callsign: string): void {
    const run = this.macroRuns.get(callsign);
    if (!run) return;
    const ac = this.aircraft.find((a) => a.callsign === callsign);
    if (!ac) { this.macroRuns.delete(callsign); return; }
    if (ac.emergency) return this.stopMacro(callsign, "emergency", false);
    if (ac.handedToTower || ac.departure?.handedOff) return this.stopMacro(callsign, "handed off", false);
    const step = nextStep(run);
    if (!step) { this.macroRuns.delete(callsign); return; }

    if (this.triggerFired(step.trigger, run, ac)) {
      // Check the whole step before sending any of it, so a step is sent whole or not at all where possible.
      for (const command of step.commands) {
        const reason = commandRefusal(command, ac);
        if (reason) return this.stopMacro(callsign, `step ${run.stepIndex + 1} refused, ${reason}`, true);
      }
      const startID = this.nextMessageID - 1;
      for (const command of step.commands) {
        const r = this.issueChecked({ callsign, command });
        if (!r.accepted) return this.stopMacro(callsign, `step ${run.stepIndex + 1} refused, ${r.reason}`, true);
      }
      if (step.commands.length > 1) this.labelChain(callsign, startID, chainCode(callsign, step.commands));
      run.stepIndex++;
      run.stepStartTick = this.tickCount;
      if (run.stepIndex >= run.macro.steps.length) {
        this.macroRuns.delete(callsign);
        return;
      }
    } else if (this.tickCount - run.stepStartTick > this.macroStepTimeoutSeconds) {
      return this.stopMacro(callsign,
        `step ${run.stepIndex + 1} waited over ${Math.trunc(this.macroStepTimeoutSeconds / 60)} min for ${step.trigger ? triggerLabel(step.trigger) : "its trigger"}`, false);
    }
    run.lastTarget = this.currentTarget(ac);
  }

  private runMacros(): void {
    for (const callsign of [...this.macroRuns.keys()].sort()) this.advanceMacro(callsign);
  }

  // MARK: Tick

  tick(): void {
    this.tickCount++;
    this.spawnTraffic();
    if (this.tickCount % 60 === 0) this.driftWind();

    const due = this.pending.filter((p) => p.executeAtTick <= this.tickCount);
    this.pending = this.pending.filter((p) => p.executeAtTick > this.tickCount);
    for (const p of due) {
      const ac = this.aircraft.find((a) => a.callsign === p.callsign);
      if (!ac) continue;
      const c = p.command;
      switch (c.k) {
        case "approach":
        case "visualApproach": {
          const ils = this.approachGeometry(c.runway);
          if (!ils) continue;
          const onRoute = ac.routeIndex < ac.route.length;
          const extra = onRoute ? this.approachLegs(c.runway, ac.route[ac.route.length - 1]?.id ?? "") : [];
          ac.clearForApproach(ils, extra);
          break;
        }
        case "direct":
          ac.setRoute(this.directRoute(ac, c.fix));
          break;
        case "resumeNavigation": {
          const route = this.resumeRoute(ac);
          ac.setRoute(route);
          if (route[0]) this.log("system", `${p.callsign} resumes own navigation, next ${route[0].id}`, { callsign: p.callsign });
          break;
        }
        case "route":
          ac.setRoute(this.routePoints(c.fixes.map((f) => ({ fixId: f }))));
          break;
        case "lineUp":
          this.moveToThreshold(ac);
          ac.apply(c);
          break;
        case "takeoff":
          if (ac.departure && this.runwayOccupied(ac.departure.runway, p.callsign)) continue;
          ac.apply(c);
          break;
        case "joinApproach": {
          const proc = this.airport?.procedures.find((x) => x.id === c.procedure);
          const ils = proc ? this.approachGeometryFor(proc) : null;
          if (!proc || !ils) continue;
          ac.setRoute(this.routePoints(proc.legs));
          ac.clearForApproach(ils, []);
          break;
        }
        default:
          ac.apply(c);
      }
      this.log("pilot", p.readback, { callsign: p.callsign });
      if (c.k === "handoff") {
        this.log("system", ac.departure === null ? `${p.callsign} handed to tower, stays on the scope until landed` : `${p.callsign} handed off`, { callsign: p.callsign });
        this.scoreHandoff(ac);
      }
    }

    for (const ac of this.aircraft) {
      ac.advance(1, this.wind);
      this.checkInterceptStall(ac);
      this.checkAboveGlidepath(ac);
      this.processPlannedEvent(ac);
      const app = ac.approach;
      if (app && !ac.departure) {
        const along = app.ils.position(ac.eastNM, ac.northNM).along;
        if (along > 0 && along <= 1.5 && this.runwayOccupied(app.ils.runwayId)) ac.abortApproach(`runway ${app.ils.runwayId} occupied`);
      }
      for (const e of ac.drainEvents()) {
        switch (e.kind) {
          case "established":
            this.log("system", `${ac.callsign} established on the localiser, runway ${e.runway}`, { callsign: ac.callsign });
            break;
          case "landed":
            this.log("system", `${ac.callsign} landed runway ${e.runway}`, { callsign: ac.callsign });
            this.addScore("landed", { callsign: ac.callsign });
            if (ac.emergency) this.addScore("emergencyLanded", { callsign: ac.callsign });
            if (this.macroRuns.has(ac.callsign)) this.stopMacro(ac.callsign, "landed", false);
            break;
          case "routeEnded":
            this.log("pilot", P.routeEndedCall(e.fix, e.headingDeg, ac), { callsign: ac.callsign });
            if (!ac.departure) this.addScore("routeEndedNoClearance", { callsign: ac.callsign, detail: `${ac.callsign} at ${e.fix}` });
            break;
          case "crossingUnable":
            this.log("pilot", P.crossingUnableCall(e.fix, e.altitudeFt, ac, this.transitionAltitudeFt), { callsign: ac.callsign, tag: "UNABLE" });
            if (this.macroRuns.has(ac.callsign)) this.stopMacro(ac.callsign, `pilot unable to cross ${e.fix}`, true);
            break;
          case "tookOff":
            this.log("system", `${ac.callsign} airborne runway ${e.runway}`, { callsign: ac.callsign });
            break;
          case "checkedIn":
            this.log("pilot", P.departureCheckIn(ac, e.passingFt, e.climbingToFt, e.sid, this.transitionAltitudeFt, ac.departure?.exitFix ?? null), { callsign: ac.callsign });
            break;
          case "wentAround":
            this.log("pilot", `Going around, ${P.spokenCallsign(ac)}`, { callsign: ac.callsign, tag: "G/A" });
            this.log("system", `${ac.callsign} go-around: ${e.reason}`, { callsign: ac.callsign, tag: "G/A" });
            if (ScoreRules.isControllerGoAround(e.reason)) {
              this.score.controllerGoArounds++;
              this.addScore("goAroundCaused", { callsign: ac.callsign, detail: `${ac.callsign}, ${e.reason}` });
            }
            if (this.macroRuns.has(ac.callsign)) this.stopMacro(ac.callsign, "go-around", false);
            break;
        }
      }
    }
    for (const ac of this.aircraft) {
      const d = ac.departure;
      if (!d || d.handedOff || ac.isOnGround || hypot(ac.eastNM, ac.northNM) <= this.areaRadiusNM) continue;
      this.missedHandoffs++;
      this.log("system", `${ac.callsign} left the area without a handoff`, { callsign: ac.callsign });
      this.score.missedHandoffs++;
      this.addScore("missedHandoff", { callsign: ac.callsign });
    }
    const isGone = (ac: Aircraft) => {
      if (ac.landed) return true;
      const d = ac.departure;
      if (!d || ac.isOnGround) return false;
      return d.handedOff || hypot(ac.eastNM, ac.northNM) > this.areaRadiusNM;
    };
    for (const ac of this.aircraft) if (isGone(ac)) this.commandHistory.delete(ac.callsign);
    this.aircraft = this.aircraft.filter((a) => !isGone(a));
    this.runMacros();
    this.updateConflicts();
    this.updateScoreEachSecond();
  }

  run(seconds: number): void {
    for (let i = 0; i < seconds; i++) this.tick();
  }
}
