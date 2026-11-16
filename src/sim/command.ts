import { approachTypeOf, spokenApproachType } from "./airport";
import type { Aircraft } from "./aircraft";
import { idiv, pad3, round } from "./util";

export type TurnDirection = "left" | "right";

/** A controller instruction. Levels in feet; headings 1...360. */
export type Command =
  | { k: "descend"; feet: number }
  | { k: "climb"; feet: number }
  | { k: "heading"; degrees: number; turn?: TurnDirection | null }
  | { k: "speed"; knots: number }
  | { k: "approach"; runway: string }
  | { k: "visualApproach"; runway: string }
  | { k: "direct"; fix: string }
  | { k: "route"; fixes: string[] }
  | { k: "cross"; fix: string; altitudeFt: number }
  | { k: "joinApproach"; procedure: string; runway: string; via: string }
  | { k: "expedite"; inner: Command }
  | { k: "maintain" }
  | { k: "resumeNavigation" }
  | { k: "lineUp" }
  | { k: "takeoff" }
  | { k: "handoff" };

export interface IssuedCommand {
  callsign: string;
  command: Command;
}

export const EXIT_FIX_TOKEN = "EXIT";

export const CommandLimits = {
  minimumLevelFt: 2000,
  maximumLevelFt: 41000,
  minimumSpeedKt: 120,
  maximumSpeedKt: 350,
  approachFloorFt(fieldElevationFt: number): number {
    return Math.max(2000, idiv(fieldElevationFt + 1000, 1000) * 1000);
  },
  floorFt(fieldElevationFt: number): number {
    return Math.max(2000, idiv(fieldElevationFt + 2000 + 999, 1000) * 1000);
  },
};

export function commandSummary(c: Command): string {
  switch (c.k) {
    case "descend": return `descend to ${c.feet} ft`;
    case "climb": return `climb to ${c.feet} ft`;
    case "heading": return `${c.turn ? `turn ${c.turn} heading` : "fly heading"} ${pad3(c.degrees)}`;
    case "speed": return `speed ${c.knots} kt`;
    case "approach": return `cleared ILS approach runway ${c.runway}`;
    case "visualApproach": return `cleared visual approach runway ${c.runway}`;
    case "direct": return `proceed direct ${c.fix}`;
    case "route": return "proceed direct " + c.fixes.join(", then ");
    case "cross": return `cross ${c.fix} at ${c.altitudeFt} ft`;
    case "joinApproach":
      return `proceed direct ${c.via}, cleared ${spokenApproachType(approachTypeOf(c.procedure))} approach runway ${c.runway} (${c.procedure})`;
    case "expedite": return "expedite: " + commandSummary(c.inner);
    case "maintain": return "maintain present heading, altitude and speed";
    case "resumeNavigation": return "resume own navigation";
    case "lineUp": return "line up and wait";
    case "takeoff": return "cleared for take-off";
    case "handoff": return "contact the next controller (tower for an arrival)";
  }
}

/** The instruction as typed on the command bar: "d70", "h270l", "p kerav pizsa". */
export function commandCode(c: Command): string {
  switch (c.k) {
    case "descend": return `d${idiv(c.feet, 100)}`;
    case "climb": return `c${idiv(c.feet, 100)}`;
    case "heading": return "h" + pad3(c.degrees) + (c.turn === "left" ? "l" : c.turn === "right" ? "r" : "");
    case "speed": return `s${c.knots}`;
    case "approach": case "visualApproach": return "i" + c.runway.toLowerCase();
    case "direct": return "p " + c.fix.toLowerCase();
    case "route": return "p " + c.fixes.map((f) => f.toLowerCase()).join(" ");
    case "cross": return `x ${c.fix.toLowerCase()} ${idiv(c.altitudeFt, 100)}`;
    case "joinApproach": return "j " + c.procedure.toLowerCase();
    case "expedite": return commandCode(c.inner) + "!";
    case "maintain": return "m";
    case "resumeNavigation": return "own";
    case "lineUp": return "lu";
    case "takeoff": return "to";
    case "handoff": return "ho";
  }
}

export function chainCode(callsign: string, commands: Command[]): string {
  return [callsign.toLowerCase(), ...commands.map(commandCode)].join(" ");
}

/** Short label for a chip: "HDG 270L", "ALT 5000". */
export function chipLabel(c: Command): string {
  switch (c.k) {
    case "descend": case "climb": return `ALT ${c.feet}`;
    case "heading": return `HDG ${pad3(c.degrees)}${c.turn ? (c.turn === "left" ? "L" : "R") : ""}`;
    case "speed": return `SPD ${c.knots}`;
    case "approach": return `ILS ${c.runway}`;
    case "visualApproach": return `VIS ${c.runway}`;
    case "direct": return `DCT ${c.fix}`;
    case "route": return "DCT " + c.fixes.join("›");
    case "cross": return `X ${c.fix} ${c.altitudeFt}`;
    case "joinApproach": return `APP ${c.procedure}`;
    case "expedite": return chipLabel(c.inner) + "!";
    case "lineUp": return "LINE UP";
    case "takeoff": return "TAKE-OFF";
    case "handoff": return "HANDOFF";
    case "maintain": return "MAINT";
    case "resumeNavigation": return "OWN NAV";
  }
}

/** Why this command cannot be accepted for the aircraft, or null if it can. */
export function commandRefusal(c: Command, ac: Aircraft): string | null {
  const current = round(ac.altitudeFt);
  if (ac.handedToTower) return `${ac.callsign} is with the tower`;
  if (ac.isOnGround && c.k !== "lineUp" && c.k !== "takeoff") return "aircraft is on the ground";
  const type = ac.type;
  switch (c.k) {
    case "descend":
      if (c.feet < ac.effectiveLevelFloorFt) return `${c.feet} ft is below the minimum altitude, ${ac.effectiveLevelFloorFt} ft`;
      if (c.feet >= current) return `${c.feet} ft is not below the aircraft (${current} ft)`;
      break;
    case "climb": {
      const ceiling = type?.ceilingFt ?? CommandLimits.maximumLevelFt;
      if (c.feet > ceiling) return `level ${c.feet} ft is above the ${ceiling} ft ceiling`;
      if (c.feet <= current) return `${c.feet} ft is not above the aircraft (${current} ft)`;
      break;
    }
    case "heading":
      if (c.degrees < 1 || c.degrees > 360) return "heading must be 0 to 360";
      break;
    case "speed": {
      const low = type?.minSpeedKt ?? CommandLimits.minimumSpeedKt;
      const high = type?.maxSpeedKt ?? CommandLimits.maximumSpeedKt;
      if (c.knots < low || c.knots > high) return `speed must be ${low} to ${high} kt` + (ac.typeCode ? ` for a ${ac.typeCode}` : "");
      break;
    }
    case "route":
      if (c.fixes.length < 2) return "a route needs at least two fixes";
      break;
    case "cross": {
      const ceiling = type?.ceilingFt ?? CommandLimits.maximumLevelFt;
      if (c.altitudeFt < ac.effectiveLevelFloorFt) return `${c.altitudeFt} ft is below the minimum altitude, ${ac.effectiveLevelFloorFt} ft`;
      if (c.altitudeFt > ceiling) return `level ${c.altitudeFt} ft is above the ${ceiling} ft ceiling`;
      break;
    }
    case "lineUp":
      if (ac.groundPhase !== "holdingShort") return "not holding short of a runway";
      break;
    case "takeoff":
      if (ac.groundPhase !== "holdingShort" && ac.groundPhase !== "linedUp") return "not holding short or lined up";
      break;
    case "handoff":
      if (ac.departure) {
        const d = ac.departure;
        const at = round(ac.altitudeFt);
        if (at < d.handoffAltitudeFt) return `climbing through ${at} ft, handoff at ${d.handoffAltitudeFt} ft`;
        if (round(ac.targetAltitudeFt) < d.expectedLevelFt) return `not cleared to its plan level, ${d.expectedLevelFt} ft`;
      } else {
        const app = ac.approach;
        if (!app || app.phase === "intercepting") return "not established on the localiser";
        if (app.phase === "localiser") {
          const p = app.ils.position(ac.eastNM, ac.northNM);
          const beam = app.ils.glidepathAltitudeFt(Math.max(p.along, 0));
          if (ac.altitudeFt > beam + 300) return `${round(ac.altitudeFt - beam)} ft above the glidepath, descend first`;
        }
      }
      break;
    case "maintain":
      if (ac.approach && ac.approach.phase !== "intercepting") return "established on the approach, give a heading to break off";
      break;
    case "expedite":
      switch (c.inner.k) {
        case "descend": case "climb": case "heading": case "speed": return commandRefusal(c.inner, ac);
        default: return "only heading, altitude and speed can be expedited";
      }
    default:
      break;
  }
  return null;
}

/** Which "slot" a command occupies when chips are collected: a second of the same kind replaces the first. */
export function commandSlot(c: Command): string {
  switch (c.k) {
    case "descend": case "climb": return "altitude";
    case "heading": return "heading";
    case "speed": return "speed";
    case "direct": case "route": case "resumeNavigation": return "direct";
    case "cross": return "crossing:" + c.fix;
    case "approach": case "visualApproach": case "joinApproach": case "lineUp": case "takeoff": return "clearance";
    case "handoff": return "handoff";
    case "maintain": return "maintain";
    case "expedite": return commandSlot(c.inner);
  }
}
