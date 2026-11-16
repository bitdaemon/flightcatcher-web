import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Aircraft } from "../src/sim/aircraft";
import { approachJoins, type AirportPackage } from "../src/sim/airport";
import { evaluate } from "../src/sim/commandBar";
import { compileMacro, runTagText, type Macro } from "../src/sim/macro";
import { Simulation } from "../src/sim/simulation";
import { aircraftType } from "../src/sim/types";

const airport = JSON.parse(readFileSync("data/airports/katl.json", "utf8")) as AirportPackage;
const fixes = new Set(airport.fixes.map((f) => f.id));
const joins = approachJoins(airport);
const m = (text: string, phase: Macro["phase"] = "arrival", name = "TEST"): Macro => ({ id: "x", name, phase, text });

function sim(): { s: Simulation; ac: Aircraft } {
  const s = new Simulation(3n, airport.transitionAltitudeFt, airport);
  const ac = new Aircraft("DAL1", 20, 0, 270, 9000, 250);
  ac.applyType(aircraftType("B738")!);
  ac.levelFloorFt = s.levelFloorFt;
  s.aircraft.push(ac);
  return { s, ac };
}

describe("macro compiler", () => {
  it("parses triggers with and without a colon", () => {
    const fix = [...fixes][0];
    const r = compileMacro(m(`s210\nat ${fix}: d50, s180\nwhen alt<40 i26l\nwhen spd <= 180: h270l\n# comment`), fixes, joins);
    expect("ok" in r).toBe(true);
    if (!("ok" in r)) return;
    expect(r.ok.steps.map((s) => s.trigger)).toEqual([
      null, { k: "atFix", fix }, { k: "altitude", cmp: "<", value: 4000 }, { k: "speed", cmp: "<=", value: 180 },
    ]);
    expect(r.ok.steps[1].commands.length).toBe(2);
  });

  it("reports errors with the step number", () => {
    const e = (text: string, phase: Macro["phase"] = "arrival") => {
      const r = compileMacro(m(text, phase), fixes, joins);
      return "error" in r ? r.error : null;
    };
    expect(e("s210\nat NOWHERE1: d30")).toEqual({ step: 2, message: "fix NOWHERE1 is not on this airport's map" });
    expect(e("when alt<4000:")?.message).toMatch(/add the instruction/);
    expect(e("lu")?.message).toBe("lu and to are for ground macros");
    expect(e("i26l", "departure")?.message).toBe("a departure macro cannot clear an approach");
    expect(e("d30", "ground")?.message).toBe("a ground macro can only use lu and to");
    expect(e("")?.message).toBe("the macro has no steps");
    expect(compileMacro({ id: "x", name: "BAD NAME", phase: "arrival", text: "s200" }, fixes)).toHaveProperty("error");
  });
});

describe("macro runs", () => {
  it("sends steps when their triggers fire", () => {
    const { s, ac } = sim();
    const c = compileMacro(m("d50 s220\nwhen alt<7000: s180\nwhen spd<=185: h200"), fixes, joins);
    if (!("ok" in c)) throw new Error("compile");
    expect(s.assignMacro(c.ok, "DAL1")).toBeNull();
    expect(runTagText(s.macroRuns.get("DAL1")!)).toBe("M TEST 2/3 A<7000");
    s.run(120);
    expect(ac.targetSpeedKt).toBe(180);
    s.run(120);
    expect(ac.targetHeadingDeg).toBe(200);
    expect(s.macroRuns.has("DAL1")).toBe(false);
  });

  it("is cancelled by a manual instruction", () => {
    const { s } = sim();
    const c = compileMacro(m("s220\nwhen alt<3000: s180"), fixes, joins);
    if (!("ok" in c)) throw new Error("compile");
    s.assignMacro(c.ok, "DAL1");
    s.issue({ callsign: "DAL1", command: { k: "heading", degrees: 90 } });
    expect(s.macroRuns.has("DAL1")).toBe(false);
    expect(s.radioLog.some((x) => x.text.includes("stopped: manual instruction"))).toBe(true);
  });

  it("stops with M! when a step is refused, and checks the phase", () => {
    const { s } = sim();
    const c = compileMacro(m("c50"), fixes, joins); // climb to 5,000 ft from 9,000 ft is refused
    if (!("ok" in c)) throw new Error("compile");
    s.assignMacro(c.ok, "DAL1");
    expect(s.radioLog.some((x) => x.tag === "M!")).toBe(true);
    const g = compileMacro(m("lu", "ground"), fixes, joins);
    if (!("ok" in g)) throw new Error("compile");
    expect(s.assignMacro(g.ok, "DAL1")).toMatch(/is a ground macro, DAL1 is an arrival/);
  });

  it("is reached from the command bar", () => {
    const { s } = sim();
    const ctx = { aircraft: s.aircraft, selected: null, knownFixes: fixes, approaches: joins, fixPositions: new Map(), openRunways: null };
    expect(evaluate("dal1 mac slow", ctx).macro).toEqual({ k: "run", callsign: "DAL1", name: "SLOW" });
    expect(evaluate("dal1 mac-", ctx).macro).toEqual({ k: "cancel", callsign: "DAL1" });
    expect(evaluate("dal1 mac", ctx).status).toBe("incomplete");
  });
});
