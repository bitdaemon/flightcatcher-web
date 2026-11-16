import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AirportPackage } from "../src/sim/airport";
import { evaluate } from "../src/sim/commandBar";
import { Simulation } from "../src/sim/simulation";
import { defaultTraffic } from "../src/sim/traffic";
import { approachJoins } from "../src/sim/airport";
import { Wind } from "../src/sim/weather";
import { Aircraft } from "../src/sim/aircraft";
import { aircraftType } from "../src/sim/types";

const dir = "data/airports/";
const load = (n: string) => JSON.parse(readFileSync(dir + n + ".json", "utf8")) as AirportPackage;

describe("simulation", () => {
  for (const name of ["katl", "kdfw", "kord", "kden", "klax", "kjfk", "kmco", "klas", "kmia", "ksfo", "kclt", "ksea", "kabe"]) {
    it(`runs an hour of traffic at ${name}`, () => {
      const a = load(name);
      const sim = new Simulation(42n, a.transitionAltitudeFt, a);
      sim.traffic = { ...defaultTraffic(), enabled: true };
      sim.events = { pilotGoAroundPercent: 3, windshearPercent: 2, emergencyPercent: 2 };
      const placed = sim.placeStartTraffic();
      const t0 = performance.now();
      sim.run(3600);
      const ms = performance.now() - t0;
      const arr = sim.radioLog.filter((m) => m.text.includes("Approach,")).length;
      const dep = sim.radioLog.filter((m) => m.text.includes("ready for departure")).length;
      console.log(name, "placed", placed, "aircraft", sim.aircraft.length, "arrivals", arr, "deps", dep, "ms", ms.toFixed(0), "open", [...sim.openRunways].join(","));
      expect(sim.aircraft.length).toBeGreaterThan(0);
    });
  }

  it("is deterministic", () => {
    const a = load("katl");
    const run = () => { const s = new Simulation(7n, a.transitionAltitudeFt, a); s.traffic = { ...defaultTraffic(), enabled: true }; s.placeStartTraffic(); s.run(900); return s.aircraft.map((x) => `${x.callsign}:${x.eastNM.toFixed(3)}`).join("|"); };
    expect(run()).toBe(run());
  });

  it("flies a vectored ILS to a landing", () => {
    const a = load("katl");
    const sim = new Simulation(1n, a.transitionAltitudeFt, a, new Wind(90, 10), false);
    const open = [...sim.openRunways];
    const rwy = open[0];
    const ils = sim.ilsGeometry(rwy)!;
    expect(ils).not.toBeNull();
    // 15 NM out on a 30 degree intercept, 4000 ft
    const back = (ils.courseDeg + 180) * Math.PI / 180;
    const e = ils.thresholdEastNM + Math.sin(back) * 15 + Math.sin((ils.courseDeg + 90) * Math.PI / 180) * 3;
    const n = ils.thresholdNorthNM + Math.cos(back) * 15 + Math.cos((ils.courseDeg + 90) * Math.PI / 180) * 3;
    const ac = new Aircraft("DAL1", e, n, (ils.courseDeg - 30 + 360) % 360, 4000, 180);
    ac.applyType(aircraftType("B738")!);
    sim["aircraft"].push(ac);
    const ctx = { aircraft: sim.aircraft, selected: null, knownFixes: sim.fixIdentifiers, approaches: approachJoins(a), fixPositions: new Map(), openRunways: sim.openRunways };
    const r = evaluate(`dal1 i${rwy.toLowerCase()} s160`, ctx);
    expect(r.status).toBe("ready");
    sim.issueChain(r.issuedAll);
    let landed = false;
    for (let i = 0; i < 900 && !landed; i++) {
      sim.tick();
      if (sim.radioLog.some((m) => m.text.includes("landed"))) landed = true;
      const x = sim.aircraft.find((z) => z.callsign === "DAL1");
      if (x && x.approach?.phase !== "intercepting" && !x.handedToTower) {
        const h = evaluate("dal1 ho", { ...ctx, aircraft: sim.aircraft });
        if (h.status === "ready") sim.issueChain(h.issuedAll);
      }
    }
    console.log(sim.radioLog.map((m) => `${m.tick} ${m.speaker}: ${m.text}`).join("\n"));
    expect(landed).toBe(true);
    expect(sim.score.arrivalsHandled).toBe(1);
  });
});
