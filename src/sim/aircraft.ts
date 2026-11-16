import { LocalProjection } from "./airport";
import { CommandLimits, type Command, type TurnDirection } from "./command";
import {
  GROUND_LABEL, ILSGeometry, type AircraftEvent, type ApproachClearance, type DepartureInfo, type EmergencyKind,
  type GroundPhase, type PlannedEvent, type RoutePoint,
} from "./navigation";
import { aircraftType, RADIO_NAMES, type AircraftType } from "./types";
import { bearingDeg, fmt1, normalized, pad3, round, signedTurn } from "./util";
import { Wind } from "./weather";

export type CaptureBlockKind = "insideGate" | "tooFar" | "headingOff" | "notClosing" | "offCourse";

interface Crossing {
  fix: string;
  altitudeFt: number;
  seen: boolean;
  checked: boolean;
}

/**
 * Point-mass aircraft in local coordinates (NM east and north of the airport reference point). Ported from
 * SimCore/Aircraft.swift; the Swift version is a value type, this one is mutated in place by the simulation.
 */
export class Aircraft {
  callsign: string;
  eastNM: number;
  northNM: number;
  headingDeg: number;
  altitudeFt: number;
  speedKt: number;

  targetHeadingDeg: number;
  targetAltitudeFt: number;
  targetSpeedKt: number;
  targetTurn: TurnDirection | null = null;

  turnRateDegPerSec = 3;
  climbRateFpm = 2000;
  descentRateFpm = 1800;
  accelerationKtPerSec = 1;

  typeCode: string | null = null;

  expeditingAltitude = false;
  expeditingHeading = false;
  expeditingSpeed = false;
  static readonly expediteAltitudeFactor = 1.6;
  static readonly expediteTurnFactor = 1.5;
  static readonly expediteSpeedFactor = 2.0;

  route: RoutePoint[] = [];
  routeIndex = 0;
  procedureId: string | null = null;
  levelFloorFt = CommandLimits.minimumLevelFt;
  approachLevelFloorFt = CommandLimits.minimumLevelFt;
  approach: ApproachClearance | null = null;
  landed = false;
  plannedEvent: PlannedEvent | null = null;
  emergency: EmergencyKind | null = null;
  private pendingEvents: AircraftEvent[] = [];

  groundPhase: GroundPhase | null = null;
  departure: DepartureInfo | null = null;
  handedToTower = false;
  crossing: Crossing | null = null;

  static readonly stableGateNM = 2.5;
  static readonly maxStableSpeedKt = 190.0;
  static readonly gateCorridorNM = 1.0;

  constructor(callsign: string, eastNM: number, northNM: number, headingDeg: number, altitudeFt: number, speedKt: number) {
    this.callsign = callsign;
    this.eastNM = eastNM;
    this.northNM = northNM;
    this.headingDeg = headingDeg;
    this.altitudeFt = altitudeFt;
    this.speedKt = speedKt;
    this.targetHeadingDeg = headingDeg;
    this.targetAltitudeFt = altitudeFt;
    this.targetSpeedKt = speedKt;
  }

  get type(): AircraftType | undefined {
    return aircraftType(this.typeCode);
  }

  get isOnGround(): boolean {
    return this.groundPhase !== null;
  }

  get effectiveLevelFloorFt(): number {
    return this.approach === null ? this.levelFloorFt : Math.min(this.levelFloorFt, this.approachLevelFloorFt);
  }

  applyType(t: AircraftType): void {
    this.typeCode = t.code;
    this.turnRateDegPerSec = t.turnRateDegPerSec;
    this.climbRateFpm = t.climbRateFpm;
    this.descentRateFpm = t.descentRateFpm;
    this.accelerationKtPerSec = t.accelerationKtPerSec;
  }

  // MARK: Commands

  apply(c: Command): void {
    switch (c.k) {
      case "descend":
      case "climb":
        this.targetAltitudeFt = c.feet;
        this.expeditingAltitude = false;
        break;
      case "cross":
        this.crossing = { fix: c.fix, altitudeFt: c.altitudeFt, seen: false, checked: false };
        break;
      case "heading":
        this.targetHeadingDeg = c.degrees % 360;
        this.targetTurn = c.turn ?? null;
        this.expeditingHeading = false;
        this.crossing = null;
        this.route = [];
        this.routeIndex = 0;
        if (this.departure) this.departure.vectored = true;
        if (this.approach && this.approach.phase !== "intercepting") this.approach = null;
        break;
      case "speed":
        this.targetSpeedKt = c.knots;
        this.expeditingSpeed = false;
        break;
      case "expedite":
        this.apply(c.inner);
        switch (c.inner.k) {
          case "descend": case "climb": this.expeditingAltitude = true; break;
          case "heading": this.expeditingHeading = true; break;
          case "speed": this.expeditingSpeed = true; break;
        }
        break;
      case "maintain":
        this.maintainPresent();
        break;
      case "lineUp":
        if (this.groundPhase === "holdingShort") this.groundPhase = "linedUp";
        break;
      case "takeoff":
        if (this.groundPhase === "holdingShort" || this.groundPhase === "linedUp") this.groundPhase = "takeoffRoll";
        break;
      case "handoff":
        if (this.departure) this.departure.handedOff = true;
        else this.handedToTower = true;
        break;
      default:
        break; // need airport data: the simulation handles these
    }
  }

  maintainPresent(): void {
    this.targetHeadingDeg = this.headingDeg;
    this.targetTurn = null;
    this.targetAltitudeFt = this.altitudeFt;
    this.targetSpeedKt = this.speedKt;
    this.expeditingAltitude = false;
    this.expeditingHeading = false;
    this.expeditingSpeed = false;
    this.crossing = null;
    this.route = [];
    this.routeIndex = 0;
    if (this.approach?.phase === "intercepting") this.approach = null;
  }

  setRoute(points: RoutePoint[]): void {
    this.route = points;
    this.routeIndex = 0;
    if (this.departure) this.departure.vectored = true;
    this.targetTurn = null;
    if (this.approach && this.approach.phase !== "intercepting") this.approach = null;
  }

  clearForApproach(ils: ILSGeometry, extraRoute: RoutePoint[]): void {
    this.approach = { ils, phase: "intercepting" };
    if (extraRoute.length > 0) this.route = this.route.concat(extraRoute);
  }

  drainEvents(): AircraftEvent[] {
    const e = this.pendingEvents;
    this.pendingEvents = [];
    return e;
  }

  // MARK: One second of flight

  advance(seconds: number, wind: Wind = Wind.calm): void {
    if (this.groundPhase !== null) {
      this.advanceOnGround(this.groundPhase, seconds);
      return;
    }
    const dep = this.departure;
    if (dep && this.altitudeFt < dep.fieldElevationFt + 400) {
      this.targetHeadingDeg = this.headingDeg;
      this.targetTurn = null;
    } else {
      this.guideLateral();
    }
    this.guideCrossing();

    let turn: number;
    if (this.targetTurn === "right") turn = normalized(this.targetHeadingDeg - this.headingDeg);
    else if (this.targetTurn === "left") turn = -normalized(this.headingDeg - this.targetHeadingDeg);
    else turn = signedTurn(this.headingDeg, this.targetHeadingDeg);
    const maxTurn = this.turnRateDegPerSec * (this.expeditingHeading ? Aircraft.expediteTurnFactor : 1) * seconds;
    if (Math.abs(turn) <= maxTurn) {
      this.headingDeg = this.targetHeadingDeg;
      this.targetTurn = null;
    } else {
      this.headingDeg += turn > 0 ? maxTurn : -maxTurn;
    }
    this.headingDeg = normalized(this.headingDeg);
    if (this.headingDeg === this.targetHeadingDeg) this.expeditingHeading = false;

    if (this.approach?.phase !== "glideslope") {
      const altDelta = this.targetAltitudeFt - this.altitudeFt;
      const maxAlt = ((altDelta > 0 ? this.climbRateFpm : this.descentRateFpm) / 60) * seconds *
        (this.expeditingAltitude ? Aircraft.expediteAltitudeFactor : 1);
      this.altitudeFt = Math.abs(altDelta) <= maxAlt ? this.targetAltitudeFt : this.altitudeFt + (altDelta > 0 ? maxAlt : -maxAlt);
    }
    if (this.altitudeFt === this.targetAltitudeFt) this.expeditingAltitude = false;

    const spdDelta = this.targetSpeedKt - this.speedKt;
    const maxSpd = this.accelerationKtPerSec * (this.expeditingSpeed ? Aircraft.expediteSpeedFactor : 1) * seconds;
    this.speedKt = Math.abs(spdDelta) <= maxSpd ? this.targetSpeedKt : this.speedKt + (spdDelta > 0 ? maxSpd : -maxSpd);
    if (this.speedKt === this.targetSpeedKt) this.expeditingSpeed = false;

    const d = LocalProjection.offset(this.headingDeg, (this.speedKt / 3600) * seconds);
    const w = wind.vectorKt(this.altitudeFt);
    this.eastNM += d.east + (w.east / 3600) * seconds;
    this.northNM += d.north + (w.north / 3600) * seconds;

    const d2 = this.departure;
    if (d2 && !d2.checkedIn && this.altitudeFt >= d2.fieldElevationFt + 1500) {
      d2.checkedIn = true;
      this.pendingEvents.push({
        kind: "checkedIn", passingFt: round(this.altitudeFt / 100) * 100, climbingToFt: d2.initialAltitudeFt, sid: d2.sid,
      });
    }
    this.updateApproachAfterMove();
  }

  private advanceOnGround(phase: GroundPhase, seconds: number): void {
    const d = this.departure;
    if (phase !== "takeoffRoll" || !d) return;
    this.speedKt += Math.max(2.0, this.accelerationKtPerSec * 3) * seconds;
    const o = LocalProjection.offset(this.headingDeg, (this.speedKt / 3600) * seconds);
    this.eastNM += o.east;
    this.northNM += o.north;
    if (this.speedKt >= d.rotateSpeedKt) {
      this.groundPhase = null;
      this.targetAltitudeFt = d.initialAltitudeFt;
      this.targetSpeedKt = Math.min(this.type?.maxSpeedKt ?? 250, 250);
      this.targetHeadingDeg = this.headingDeg;
      this.targetTurn = null;
      this.pendingEvents.push({ kind: "tookOff", runway: d.runway });
    }
  }

  // MARK: Crossing restrictions

  private guideCrossing(): void {
    const c = this.crossing;
    if (!c || this.approach?.phase === "glideslope") return;
    let k = -1;
    for (let i = this.routeIndex; i < this.route.length; i++) {
      if (this.route[i].id === c.fix) { k = i; break; }
    }
    if (k < 0) {
      if (c.seen) this.crossing = null;
      return;
    }
    c.seen = true;
    const r0 = this.route[this.routeIndex];
    let distance = Math.hypot(r0.eastNM - this.eastNM, r0.northNM - this.northNM);
    for (let i = this.routeIndex; i < k; i++) {
      distance += Math.hypot(this.route[i + 1].eastNM - this.route[i].eastNM, this.route[i + 1].northNM - this.route[i].northNM);
    }
    const delta = c.altitudeFt - this.altitudeFt;
    if (Math.abs(delta) <= 50) {
      this.targetAltitudeFt = c.altitudeFt;
    } else {
      const rate = (delta > 0 ? this.climbRateFpm : this.descentRateFpm) / 60;
      const needed = Math.abs(delta) / rate;
      const available = (distance / Math.max(this.speedKt, 1)) * 3600;
      if (!c.checked) {
        c.checked = true;
        if (available < needed - 15) this.pendingEvents.push({ kind: "crossingUnable", fix: c.fix, altitudeFt: Math.trunc(c.altitudeFt) });
      }
      this.targetAltitudeFt = available <= needed + 8 ? c.altitudeFt : this.altitudeFt;
    }
  }

  // MARK: Lateral guidance

  private guideLateral(): void {
    const app = this.approach;
    if (app) {
      const p = app.ils.position(this.eastNM, this.northNM);
      if (app.phase === "intercepting" && this.captureBlock(app.ils, p.along, p.cross) === null) {
        app.phase = "localiser";
        this.route = [];
        this.routeIndex = 0;
        this.pendingEvents.push({ kind: "established", runway: app.ils.runwayId });
      }
      if (app.phase !== "intercepting") {
        const offset = Math.max(-30, Math.min(30, p.cross * 40));
        this.targetHeadingDeg = normalized(app.ils.courseDeg - offset);
        this.targetTurn = null;
        return;
      }
    }
    this.guideAlongRoute();
  }

  private captureBlock(ils: ILSGeometry, along: number, cross: number): { kind: CaptureBlockKind; text: string } | null {
    if (along <= Aircraft.stableGateNM) {
      return { kind: "insideGate", text: `inside the ${fmt1(Aircraft.stableGateNM)} NM gate, ${fmt1(along)} NM from the threshold` };
    }
    if (along >= 30) return { kind: "tooFar", text: `too far out, ${fmt1(along)} NM from the threshold (limit 30)` };
    const delta = Math.abs(signedTurn(this.headingDeg, ils.courseDeg));
    if (delta > 60) {
      return {
        kind: "headingOff",
        text: `heading ${round(this.headingDeg)} is ${round(delta)} degrees off the course ${round(ils.courseDeg)} (limit 60)`,
      };
    }
    const h = (this.headingDeg * Math.PI) / 180;
    const c = (ils.courseDeg * Math.PI) / 180;
    const towardRight = Math.sin(h) * Math.cos(c) - Math.cos(h) * Math.sin(c);
    if (!(cross * towardRight < 0 || Math.abs(cross) < 0.05)) {
      return { kind: "notClosing", text: `not closing on the course, ${fmt1(Math.abs(cross))} NM off it and moving away` };
    }
    const radius = this.speedKt / 3600 / ((this.turnRateDegPerSec * Math.PI) / 180);
    const lead = radius * (1 - Math.cos((delta * Math.PI) / 180)) + 0.1;
    if (Math.abs(cross) > lead) {
      return { kind: "offCourse", text: `${fmt1(Math.abs(cross))} NM off the course, turn starts within ${fmt1(lead)} NM` };
    }
    return null;
  }

  captureBlocker(): { kind: CaptureBlockKind; text: string } | null {
    const app = this.approach;
    if (!app || app.phase !== "intercepting") return null;
    const p = app.ils.position(this.eastNM, this.northNM);
    return this.captureBlock(app.ils, p.along, p.cross);
  }

  private guideAlongRoute(): void {
    if (this.route.length === 0) return;
    let steps = 0;
    while (this.routeIndex < this.route.length && steps < 4) {
      steps++;
      const fix = this.route[this.routeIndex];
      const toE = fix.eastNM - this.eastNM;
      const toN = fix.northNM - this.northNM;
      const distance = Math.hypot(toE, toN);
      let passed: boolean;
      if (this.routeIndex + 1 < this.route.length) {
        const next = this.route[this.routeIndex + 1];
        const radius = this.speedKt / 3600 / ((this.turnRateDegPerSec * Math.PI) / 180);
        const nowBearing = bearingDeg(toE, toN);
        const nextBearing = bearingDeg(next.eastNM - fix.eastNM, next.northNM - fix.northNM);
        const delta = Math.abs(signedTurn(nowBearing, nextBearing));
        passed = distance <= Math.max(0.15, radius * Math.tan((Math.min(delta, 150) * Math.PI) / 360));
      } else {
        passed = distance <= 0.3;
      }
      if (!passed && distance < 1.5) {
        const h = (this.headingDeg * Math.PI) / 180;
        if (Math.sin(h) * toE + Math.cos(h) * toN < 0) passed = true;
      }
      if (passed) {
        if (this.crossing && this.crossing.fix === fix.id) {
          this.targetAltitudeFt = this.crossing.altitudeFt;
          this.crossing = null;
        }
        this.routeIndex++;
      } else break;
    }
    if (this.routeIndex >= this.route.length) {
      if (this.approach === null && this.route.length > 0) {
        const last = this.route[this.route.length - 1];
        const rounded = round(this.headingDeg) % 360;
        this.pendingEvents.push({ kind: "routeEnded", fix: last.id, headingDeg: rounded === 0 ? 360 : rounded });
      }
      this.crossing = null;
      this.route = [];
      this.routeIndex = 0;
      this.targetHeadingDeg = this.headingDeg;
      this.targetTurn = null;
      return;
    }
    const fix = this.route[this.routeIndex];
    this.targetHeadingDeg = bearingDeg(fix.eastNM - this.eastNM, fix.northNM - this.northNM);
    this.targetTurn = null;
  }

  // MARK: Glidepath, landing and go-around

  private updateApproachAfterMove(): void {
    const app = this.approach;
    if (!app) return;
    const ils = app.ils;
    const p = ils.position(this.eastNM, this.northNM);
    const beam = ils.glidepathAltitudeFt(Math.max(p.along, 0));

    if (app.phase === "localiser" && p.along > 0) {
      const diff = beam - this.altitudeFt;
      if (diff <= 50 && diff >= -300) app.phase = "glideslope";
    }

    if (app.phase === "glideslope") {
      const diff = beam - this.altitudeFt;
      this.altitudeFt = Math.abs(diff) <= 60 ? beam : this.altitudeFt + Math.max(-40, Math.min(40, diff));
      this.targetAltitudeFt = this.altitudeFt;
      const vapp = this.type?.approachSpeedKt;
      const limit = vapp !== undefined
        ? (p.along > 8 ? vapp + 45 : p.along > 5 ? vapp + 25 : vapp + 5)
        : (p.along > 8 ? 180 : p.along > 5 ? 160 : 140);
      this.targetSpeedKt = Math.min(this.targetSpeedKt, limit);
      if (p.along <= 0) {
        this.landed = true;
        this.approach = null;
        this.pendingEvents.push({ kind: "landed", runway: ils.runwayId });
        return;
      }
    }

    const onFinal = app.phase !== "intercepting" || (Math.abs(p.cross) <= Aircraft.gateCorridorNM && p.along > -0.5);
    if (p.along <= Aircraft.stableGateNM && onFinal) {
      if (app.phase !== "glideslope") {
        const above = round(this.altitudeFt - beam);
        this.goAround(above > 300
          ? `${above} ft above the glidepath inside ${Aircraft.stableGateNM} NM`
          : `not established inside ${Aircraft.stableGateNM} NM`);
      } else if (this.speedKt > Aircraft.maxStableSpeedKt) {
        this.goAround(`unstable, ${round(this.speedKt)} kt inside ${Aircraft.stableGateNM} NM`);
      }
    }
  }

  /** Where the aircraft will reach `levelFt` at its current speed, along its route or heading. */
  levelPoint(levelFt: number, expedited: boolean): { eastNM: number; northNM: number; bearingDeg: number } | null {
    if (this.isOnGround || this.approach?.phase === "glideslope") return null;
    const delta = levelFt - this.altitudeFt;
    if (Math.abs(delta) <= 50) return null;
    const rateFpm = (delta > 0 ? this.climbRateFpm : this.descentRateFpm) * (expedited ? Aircraft.expediteAltitudeFactor : 1);
    if (rateFpm <= 0) return null;
    let remaining = (this.speedKt * (Math.abs(delta) / rateFpm)) / 60;
    let east = this.eastNM;
    let north = this.northNM;
    let bearing = this.routeIndex < this.route.length ? this.headingDeg : this.targetHeadingDeg;
    let i = this.routeIndex;
    while (remaining > 0 && i < this.route.length) {
      const dx = this.route[i].eastNM - east;
      const dy = this.route[i].northNM - north;
      const leg = Math.hypot(dx, dy);
      if (leg > 0) bearing = bearingDeg(dx, dy);
      if (leg >= remaining) {
        const f = leg > 0 ? remaining / leg : 0;
        return { eastNM: east + dx * f, northNM: north + dy * f, bearingDeg: bearing };
      }
      east = this.route[i].eastNM;
      north = this.route[i].northNM;
      remaining -= leg;
      i++;
    }
    const step = LocalProjection.offset(bearing, remaining);
    return { eastNM: east + step.east, northNM: north + step.north, bearingDeg: bearing };
  }

  abortApproach(reason: string): void {
    this.goAround(reason);
  }

  private goAround(reason: string): void {
    this.handedToTower = false;
    const course = this.approach?.ils.courseDeg ?? this.headingDeg;
    const field = this.approach?.ils.thresholdElevationFt ?? 0;
    const missedAltitude = Math.max(3000, Math.ceil((field + 2500) / 1000) * 1000);
    this.pendingEvents.push({ kind: "wentAround", reason });
    this.approach = null;
    this.route = [];
    this.routeIndex = 0;
    this.targetHeadingDeg = normalized(course);
    this.targetTurn = null;
    this.targetAltitudeFt = missedAltitude;
    this.targetSpeedKt = 200;
  }

  // MARK: Callsign parts and labels

  get callsignLetters(): string {
    const m = /^[A-Za-z]*/.exec(this.callsign);
    return m ? m[0] : "";
  }

  get callsignNumber(): string {
    return this.callsign.slice(this.callsignLetters.length);
  }

  get radioName(): string | undefined {
    return RADIO_NAMES.get(this.callsignLetters.toUpperCase());
  }

  get labelBottom(): string {
    if (this.groundPhase) return `${GROUND_LABEL[this.groundPhase]} ${this.departure?.runway ?? ""}`;
    const text = `${pad3(round(this.speedKt))} ${pad3(round(this.altitudeFt / 100))}`;
    return this.handedToTower ? text + " TWR" : text;
  }

  get onRunwayHeading(): boolean {
    const d = this.departure;
    return !!d && d.sid === "" && !d.vectored && !d.handedOff;
  }

  get navLabel(): string {
    if (this.groundPhase) return GROUND_LABEL[this.groundPhase];
    if (this.onRunwayHeading) return "RWYHDG";
    if (this.handedToTower) return "TWR";
    if (this.approach) {
      if (this.approach.phase === "glideslope") return "G/S";
      if (this.approach.phase === "localiser") return "LOC";
    }
    if (this.routeIndex < this.route.length) return this.route[this.routeIndex].id;
    return this.approach ? "ILS" : "HDG";
  }
}
