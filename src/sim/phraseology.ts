// Spoken forms for the radio log (Doc 4444 chapter 12 wording, SERA.14035 numbers). Ported from Phraseology.swift.
import { approachTypeOf, spokenApproachType } from "./airport";
import type { Aircraft } from "./aircraft";
import type { Command } from "./command";
import { idiv, pad3, round } from "./util";
import type { Wind } from "./weather";

export type NumberStyle = "plain" | "icao";
let numberStyle: NumberStyle = "plain";
export function setNumberStyle(s: NumberStyle): void {
  numberStyle = s;
}

function digitWords(): string[] {
  return numberStyle === "plain"
    ? ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "niner"]
    : ["zero", "one", "two", "tree", "fower", "fife", "six", "seven", "eight", "niner"];
}

const PHONETIC: Record<string, string> = {
  A: "Alfa", B: "Bravo", C: "Charlie", D: "Delta", E: "Echo", F: "Foxtrot", G: "Golf", H: "Hotel", I: "India",
  J: "Juliett", K: "Kilo", L: "Lima", M: "Mike", N: "November", O: "Oscar", P: "Papa", Q: "Quebec", R: "Romeo",
  S: "Sierra", T: "Tango", U: "Uniform", V: "Victor", W: "Whiskey", X: "X-ray", Y: "Yankee", Z: "Zulu",
};

export function spokenDigits(text: string): string {
  const words = digitWords();
  const out: string[] = [];
  for (const ch of text) {
    if (ch >= "0" && ch <= "9") out.push(words[Number(ch)]);
    else {
      const p = PHONETIC[ch.toUpperCase()];
      if (p) out.push(p);
    }
  }
  return out.join(" ");
}

export function spokenRunway(id: string): string {
  const digits = /^\d*/.exec(id)![0];
  const suffix = id.slice(digits.length).toUpperCase();
  let words = spokenDigits(digits);
  if (suffix === "L") words += " left";
  else if (suffix === "R") words += " right";
  else if (suffix === "C") words += " centre";
  return words;
}

export function spokenCallsign(ac: Aircraft): string {
  const radio = ac.radioName;
  if (radio) {
    const number = ac.callsignNumber;
    return number ? `${radio} ${spokenDigits(number)}` : radio;
  }
  return spokenDigits(ac.callsign);
}

export function spokenLevel(feet: number, transitionAltitudeFt: number): string {
  if (feet > transitionAltitudeFt) {
    const level = idiv(feet, 100);
    if (level % 100 === 0) return "flight level " + spokenDigits(String(idiv(level, 100))) + " hundred";
    return "flight level " + spokenDigits(String(level));
  }
  const thousands = idiv(feet, 1000);
  const hundreds = idiv(feet % 1000, 100);
  const parts: string[] = [];
  if (thousands > 0) parts.push(spokenDigits(String(thousands)) + " thousand");
  if (hundreds > 0) parts.push(spokenDigits(String(hundreds)) + " hundred");
  if (parts.length === 0) parts.push("zero");
  return parts.join(" ") + " feet";
}

export function spokenProcedure(id: string): string {
  const base = id.split(".")[0] ?? id;
  const name = /^[A-Za-z]*/.exec(base)![0];
  const rest = base.slice(name.length);
  const digits = /^\d*/.exec(rest)![0];
  const suffix = rest.slice(digits.length);
  return [name, spokenDigits(digits), spokenDigits(suffix)].filter((s) => s.length > 0).join(" ");
}

export function instruction(c: Command, ac: Aircraft, ta: number): string {
  switch (c.k) {
    case "descend": return "descend to " + spokenLevel(c.feet, ta);
    case "climb": return "climb to " + spokenLevel(c.feet, ta);
    case "heading": return (c.turn ? `turn ${c.turn} heading ` : "fly heading ") + spokenDigits(pad3(c.degrees));
    case "approach": return "cleared ILS approach runway " + spokenRunway(c.runway);
    case "visualApproach": return "cleared visual approach runway " + spokenRunway(c.runway);
    case "expedite": {
      const inner = c.inner;
      switch (inner.k) {
        case "descend": return "expedite descent to " + spokenLevel(inner.feet, ta);
        case "climb": return "expedite climb to " + spokenLevel(inner.feet, ta);
        case "heading":
          return (inner.turn ? `turn ${inner.turn} immediately heading ` : "turn immediately heading ") + spokenDigits(pad3(inner.degrees));
        case "speed":
          return (inner.knots < ac.speedKt ? "reduce" : "increase") + ` speed immediately to ${spokenDigits(String(inner.knots))} knots`;
        default: return instruction(inner, ac, ta);
      }
    }
    case "direct": return "proceed direct " + c.fix.toUpperCase();
    case "cross": return `cross ${c.fix.toUpperCase()} at ` + spokenLevel(c.altitudeFt, ta);
    case "route": return "proceed direct " + c.fixes.map((f) => f.toUpperCase()).join(", then ");
    case "joinApproach":
      return `proceed direct ${c.via.toUpperCase()}, cleared ${spokenApproachType(approachTypeOf(c.procedure))} approach runway ` + spokenRunway(c.runway);
    case "maintain": return "maintain present heading, altitude and speed";
    case "resumeNavigation": return "resume own navigation";
    case "lineUp": return "line up and wait runway " + spokenRunway(ac.departure?.runway ?? "");
    case "takeoff": {
      const clearance = `runway ${spokenRunway(ac.departure?.runway ?? "")}, cleared for take-off`;
      const d = ac.departure;
      if (!d) return clearance;
      const level = spokenLevel(d.initialAltitudeFt, ta);
      if (d.sid === "") return `fly runway heading, climb to ${level}, ` + clearance;
      return `${spokenProcedure(d.sid)} departure, climb and maintain ${level}, ` + clearance;
    }
    case "handoff": return ac.departure === null ? "contact tower" : "contact area control, good day";
    case "speed": {
      const words = spokenDigits(String(c.knots));
      const delta = c.knots - ac.speedKt;
      if (Math.abs(delta) < 0.5) return `maintain ${words} knots`;
      return (delta < 0 ? "reduce" : "increase") + ` speed to ${words} knots`;
    }
  }
}

export function spokenWind(w: Wind): string {
  if (w.speedKt < 0.5) return "wind calm";
  const r = round(w.fromDeg) % 360;
  return `wind ${spokenDigits(pad3(r === 0 ? 360 : r))} degrees ${spokenDigits(String(round(w.speedKt)))} knots`;
}

export function takeoffCall(ac: Aircraft, wind: Wind, ta = 18000): string {
  return `${spokenCallsign(ac)}, ${spokenWind(wind)}, ` + instruction({ k: "takeoff" }, ac, ta);
}

export function approachCheckIn(ac: Aircraft, facility: string, altitudeFt: number, ta: number): string {
  return `${facility}, ${spokenCallsign(ac)}, ${spokenLevel(altitudeFt, ta)}`;
}

export function departureCheckIn(ac: Aircraft, passingFt: number, climbingToFt: number, sid: string, ta: number,
                                 exitFix: string | null): string {
  return `Departure, ${spokenCallsign(ac)}, passing ${spokenLevel(passingFt, ta)}, climbing ${spokenLevel(climbingToFt, ta)}, ` +
    (sid === "" ? "runway heading" + (exitFix ? `, requesting direct ${exitFix}` : "") : `${spokenProcedure(sid)} departure`);
}

export function routeEndedCall(fix: string, headingDeg: number, ac: Aircraft): string {
  return `Overhead ${fix.toUpperCase()}, maintaining heading ${spokenDigits(pad3(headingDeg))}, ${spokenCallsign(ac)}`;
}

export function crossingUnableCall(fix: string, altitudeFt: number, ac: Aircraft, ta: number): string {
  return `Unable to cross ${fix.toUpperCase()} at ${spokenLevel(altitudeFt, ta)}, ${spokenCallsign(ac)}`;
}

export function controllerCall(c: Command, ac: Aircraft, ta: number): string {
  return `${spokenCallsign(ac)}, ` + instruction(c, ac, ta);
}

export function readback(c: Command, ac: Aircraft, ta: number): string {
  const text = instruction(c, ac, ta);
  return text.charAt(0).toUpperCase() + text.slice(1) + ", " + spokenCallsign(ac);
}
