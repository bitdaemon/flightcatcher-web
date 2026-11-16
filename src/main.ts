import "./styles.css";
import { registerSW } from "virtual:pwa-register";
import { airportTitle, approachJoins, referenceProjection, type AirportIndexEntry, type AirportPackage, type ApproachJoin, type LocalPoint } from "./sim/airport";
import { chipLabel, commandCode, commandRefusal, commandSlot, type Command, type IssuedCommand } from "./sim/command";
import { evaluate, newTabState, runwayChoices, tabComplete } from "./sim/commandBar";
import { setNumberStyle } from "./sim/phraseology";
import { randomSeed } from "./sim/rng";
import { Simulation, tagSeverity, type RadioMessage } from "./sim/simulation";
import { pad2, pad3, round } from "./sim/util";
import { WEATHER_MODE_TITLES } from "./sim/weather";
import { loadIndex, loadPackage } from "./data/airports";
import { loadSettings, saveSettings, type Settings } from "./data/settings";
import { fetchMetar } from "./data/weather";
import { Scope } from "./ui/scope";
import { applyScheme, scheme } from "./ui/theme";
import { openAirportDialog, openDebrief, openHelp, openMacros, openSettings } from "./ui/dialogs";
import { RunwayMap } from "./ui/runwayMap";
import { compileMacro, macroErrorText, phaseOf, runTagText, type Macro } from "./sim/macro";
import { loadMacros, saveMacros } from "./data/settings";
import { aircraftType } from "./sim/types";
import type { Aircraft } from "./sim/aircraft";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export class App {
  settings: Settings = loadSettings();
  index: AirportIndexEntry[] = [];
  airport: AirportPackage | null = null;
  sim: Simulation | null = null;
  selected: string | null = null;
  running = true;
  speed = 1;
  trafficSeed = 0n;
  private acc = 0;
  private last = performance.now();
  private lastPanelTick = -1;
  private lastPanelTime = 0;
  private fixIds = new Set<string>();
  private joins = new Map<string, ApproachJoin>();
  private fixPositions = new Map<string, LocalPoint>();
  private available = new Set<string>();
  private tab = newTabState();
  private history: string[] = [];
  private historyIndex = -1;
  private weatherTimer: number | null = null;
  windSource = "Random drift";
  nextWeather: Date | null = null;
  private noticeTimer: number | null = null;
  private lastSpoken = -1;
  private scope: Scope;
  private runwayMap: RunwayMap;
  /** The current airport's macros, saved on every change. */
  macros: Macro[] = [];
  private lastScoreTotal = 0;
  private lastScoreText = "";

  constructor() {
    applyScheme(scheme(this.settings.scheme));
    setNumberStyle(this.settings.numberStyle);
    this.scope = new Scope($<HTMLCanvasElement>("scope"), {
      select: (cs) => this.select(cs),
      radial: (cs, x, y) => this.openRadial(cs, x, y),
      heading: (cs, deg, invert) => this.pickHeading(cs, deg, invert),
      direct: (cs, fix) => this.pickRouteFix(cs, fix),
      crossFix: (cs, fix) => this.openCrossAltitude(cs, fix),
      cancelMode: () => this.endMode(),
    });
    this.runwayMap = new RunwayMap($<HTMLCanvasElement>("runway-canvas"));
    this.bindUI();
    this.applyPanels();
    this.applyLayers();
    requestAnimationFrame((t) => this.frame(t));
    void this.boot();
  }

  // MARK: Loading

  private async boot(): Promise<void> {
    try {
      this.index = await loadIndex();
    } catch (e) {
      this.notice(`Could not load the airport list: ${(e as Error).message}`, 10000);
      return;
    }
    const want = this.settings.airport.toUpperCase();
    const entry = this.index.find((e) => e.icao === want) ?? this.index.find((e) => e.icao === "KATL") ?? this.index[0];
    await this.loadAirport(entry.icao);
  }

  async loadAirport(icao: string): Promise<boolean> {
    let pkg: AirportPackage;
    try {
      pkg = await loadPackage(icao);
    } catch (e) {
      this.notice(`${icao}: ${navigator.onLine ? (e as Error).message : "not downloaded, and you are offline"}`, 6000);
      return false;
    }
    this.airport = pkg;
    this.settings.airport = pkg.icao;
    saveSettings(this.settings);
    this.fixIds = new Set(pkg.fixes.map((f) => f.id));
    this.macros = loadMacros(pkg.icao);
    this.joins = approachJoins(pkg);
    const proj = referenceProjection(pkg);
    this.fixPositions = new Map(pkg.fixes.map((f) => [f.id, proj.nm(f.lat, f.lon)]));
    $("airport-title").textContent = airportTitle(pkg.city, pkg.name, pkg.icao);
    document.title = `${pkg.icao} · flightcATCher`;
    this.newSession();
    return true;
  }

  newSession(): void {
    const pkg = this.airport;
    if (!pkg) return;
    const s = this.settings;
    const sim = new Simulation(randomSeed(), pkg.transitionAltitudeFt, pkg);
    sim.areaRadiusNM = s.areaRadiusNM;
    sim.areaCeilingFt = s.areaCeilingFt;
    sim.weatherMode = s.weatherMode;
    this.trafficSeed = s.traffic.fixedSeed ? BigInt(s.traffic.fixedSeed) : randomSeed();
    sim.reseedTraffic(this.trafficSeed);
    sim.events = { ...s.events };
    this.sim = sim;
    this.selected = null;
    this.lastSpoken = -1;
    this.lastScoreTotal = 0;
    this.lastScoreText = "";
    this.endMode();
    this.closeRadial();
    this.fitScope();
    this.updateAvailable();
    this.startWeather(true);
    this.running = true;
    this.updateRunButton();
    this.renderPanels(true);
  }

  /** Fits the approach area into the part of the scope that the side panels leave free. */
  fitScope(): void {
    const wide = window.innerWidth >= 760;
    const width = (id: string) => (wide && !$(id).classList.contains("hidden") ? $(id).offsetWidth + 8 : 0);
    this.scope.fit(this.sim?.areaRadiusNM ?? 40, { left: Math.max(width("strips"), width("runways")), right: Math.max(width("info"), width("radio")) });
  }

  private spawnStart(): void {
    const sim = this.sim;
    if (!sim) return;
    sim.traffic = { ...this.settings.traffic };
    if (this.settings.traffic.enabled) sim.placeStartTraffic();
    this.updateAvailable();
  }

  private startWeather(spawn: boolean): void {
    if (this.weatherTimer !== null) clearTimeout(this.weatherTimer);
    this.weatherTimer = null;
    this.nextWeather = null;
    const sim = this.sim;
    if (!sim || !this.airport) return;
    if (this.settings.weatherMode !== "live") {
      this.windSource = this.settings.weatherMode === "fixed" ? "Fixed" : "Random drift";
      if (spawn) this.spawnStart();
      return;
    }
    this.windSource = "Live, fetching…";
    const icao = this.airport.icao;
    let first = true;
    const run = async () => {
      const report = await fetchMetar(icao);
      if (this.sim !== sim) return;
      if (report) {
        sim.setLiveWeather(report, first && spawn);
        this.windSource = `Real, METAR ${icao}`;
        this.notice(`Weather updated, ${icao}: wind ${sim.liveReport ? sim.wind.text : "?"}`);
      } else {
        this.windSource = "Random, METAR unavailable";
        if (first) this.notice(`No METAR for ${icao} (offline or blocked), wind drifts randomly`);
      }
      if (first && spawn) this.spawnStart();
      first = false;
      this.nextWeather = new Date(Date.now() + 15 * 60_000);
      this.weatherTimer = window.setTimeout(run, 15 * 60_000);
      this.renderPanels(true);
    };
    void run();
  }

  private updateAvailable(): void {
    const sim = this.sim;
    this.available = new Set((this.airport?.procedures ?? []).filter((p) => sim?.isAvailable(p)).map((p) => p.id));
  }

  // MARK: Loop

  private frame(t: number): void {
    const dt = Math.min(0.25, (t - this.last) / 1000);
    this.last = t;
    const sim = this.sim;
    if (sim && this.running && !document.hidden) {
      this.acc += dt * this.speed;
      let n = 0;
      const open = [...sim.openRunways].join();
      while (this.acc >= 1 && n < 30) {
        sim.tick();
        this.acc -= 1;
        n++;
      }
      if (n >= 30) this.acc = 0;
      if (n > 0) {
        if ([...sim.openRunways].join() !== open) this.updateAvailable();
        if (this.selected && !sim.aircraft.some((a) => a.callsign === this.selected)) this.select(null);
        this.speakNew();
      }
    }
    const colors = scheme(this.settings.scheme).colors;
    this.scope.draw(sim, this.airport, this.selected, colors, this.settings.layers, this.available, this.commandTags(), this.macroTags());
    if (this.settings.panels.runways) this.runwayMap.draw(sim, this.airport, this.selected, colors);
    if (sim && (sim.tickCount !== this.lastPanelTick && t - this.lastPanelTime > 250)) {
      this.lastPanelTick = sim.tickCount;
      this.lastPanelTime = t;
      this.renderPanels(false);
    }
    if (this.chips) this.placeChips();
    requestAnimationFrame((x) => this.frame(x));
  }

  /** Last instruction per aircraft, for its tag: "HDG 270…" while the pilot has not yet acted on it. */
  private commandTags(): Map<string, string> {
    const out = new Map<string, string>();
    const sim = this.sim;
    if (!sim) return out;
    for (const [cs, list] of sim.commandHistory) {
      const last = list[list.length - 1];
      if (!last || sim.tickCount - last.issuedTick > 90) continue;
      out.set(cs, chipLabel(last.command) + (last.executeAtTick > sim.tickCount ? "…" : ""));
    }
    return out;
  }

  /** Macro line for each aircraft's tag: "M APPR 2/4 @CAPE". */
  macroTags(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [cs, run] of this.sim?.macroRuns ?? []) out.set(cs, runTagText(run));
    return out;
  }

  // MARK: Macros

  saveMacros(): void {
    if (this.airport) saveMacros(this.airport.icao, this.macros);
  }

  /** The airport's macros that suit this aircraft, by name. */
  macrosFor(ac: Aircraft): Macro[] {
    const phase = phaseOf(ac);
    return this.macros.filter((m) => m.phase === phase).sort((a, b) => a.name.localeCompare(b.name));
  }

  compile(m: Macro) {
    return compileMacro(m, this.fixIds, this.joins);
  }

  /** Compiles the named macro and starts it on the aircraft. Returns why it cannot run, or null. */
  runMacro(name: string, callsign: string): string | null {
    const sim = this.sim;
    if (!sim) return "no session";
    const m = this.macros.find((x) => x.name.toUpperCase() === name.toUpperCase());
    if (!m) return `no macro called ${name.toUpperCase()} at this airport`;
    const c = this.compile(m);
    const result = "ok" in c ? sim.assignMacro(c.ok, callsign) : `${m.name}: ${macroErrorText(c.error)}`;
    if (result) this.notice(`${callsign}: ${result}`, 4500);
    this.selected = callsign;
    this.renderPanels(true);
    return result;
  }

  cancelMacro(callsign: string): void {
    if (!this.sim?.cancelMacro(callsign)) this.notice(`${callsign} has no macro running`);
    this.renderPanels(true);
  }

  // MARK: Commands

  send(chain: IssuedCommand[]): boolean {
    const sim = this.sim;
    if (!sim || chain.length === 0) return false;
    const results = sim.issueChain(chain);
    const refused = results.map((r, i) => (r.accepted ? null : `${chainLabel(chain[i].command)}: ${r.reason}`)).filter(Boolean);
    if (refused.length) this.notice(`${chain[0].callsign} unable: ${refused.join("; ")}`, 4500);
    this.selected = chain[0].callsign;
    this.renderPanels(true);
    return refused.length === 0;
  }

  select(cs: string | null): void {
    this.selected = cs;
    this.closeRadial();
    if (this.scope.mode.kind !== "none" && this.scope.mode.callsign !== cs) this.endMode();
    this.renderPanels(true);
    this.updatePreview();
  }

  private evalContext() {
    return {
      aircraft: this.sim?.aircraft ?? [],
      selected: this.selected,
      knownFixes: this.fixIds,
      approaches: this.joins,
      fixPositions: this.fixPositions,
      openRunways: this.sim?.openRunways ?? null,
    };
  }

  private updatePreview(): void {
    const input = $<HTMLInputElement>("cmd").value;
    const pv = $("cmd-preview");
    if (!input.trim()) {
      pv.className = "preview mono";
      pv.textContent = this.selected
        ? `${this.selected} selected: type codes (d70 s180 h270l i27 p fix j27 lu to ho), or right-click / long-press it for the menu`
        : "Click an aircraft to select it. Right-click (long-press on touch) for its menu. ? for all commands.";
      return;
    }
    const r = evaluate(input, this.evalContext());
    pv.className = "preview mono " + r.status;
    pv.textContent = r.message;
  }

  private submitCommand(): void {
    const el = $<HTMLInputElement>("cmd");
    const input = el.value;
    if (!input.trim()) { this.sendChips(); return; }
    const r = evaluate(input, this.evalContext());
    if (r.status === "ready" && r.macro) {
      const failed = r.macro.k === "run" ? this.runMacro(r.macro.name, r.macro.callsign) !== null : (this.cancelMacro(r.macro.callsign), false);
      if (!failed) {
        this.history.unshift(input);
        this.historyIndex = -1;
        el.value = "";
      }
    } else if (r.status === "ready") {
      if (this.send(r.issuedAll)) {
        this.history.unshift(input);
        this.history = this.history.slice(0, 50);
        this.historyIndex = -1;
        el.value = "";
      }
    } else if (r.selects) {
      this.select(r.selects);
      el.value = "";
    } else {
      this.notice(r.message, 3500);
    }
    this.updatePreview();
  }

  // MARK: Radial menu and pickers

  private openRadial(cs: string, x: number, y: number): void {
    const sim = this.sim;
    const ac = sim?.aircraft.find((a) => a.callsign === cs);
    if (!sim || !ac) return;
    if (this.chips && this.chips.callsign !== cs) { this.chips = null; this.renderChips(); }
    this.select(cs);
    const el = $("radial");
    el.innerHTML = "";
    const p = this.scope.screenOf(ac);
    const size = this.scope.size;
    const cx = Math.min(Math.max(p.x, 110), size.w - 110);
    const cy = Math.min(Math.max(p.y, 110), size.h - 110);
    el.style.left = cx + "px";
    el.style.top = cy + "px";
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = cs;
    el.appendChild(label);
    type Item = { t: string; f: () => void; small?: boolean; off?: boolean };
    const items: Item[] = [];
    const cmd = (c: Command) => () => this.addChip(cs, c);
    if (ac.handedToTower) {
      items.push({ t: "TWR", f: () => this.closeRadial(), off: true });
    } else if (ac.isOnGround) {
      items.push({ t: "LUP", f: cmd({ k: "lineUp" }), off: ac.groundPhase !== "holdingShort" });
      items.push({ t: "T/O", f: cmd({ k: "takeoff" }), off: ac.groundPhase === "takeoffRoll" });
    } else {
      items.push({ t: "HDG", f: () => this.beginHeading(cs) });
      items.push({ t: "ALT", f: () => this.openAltitude(cs, cx, cy) });
      items.push({ t: "SPD", f: () => this.openSpeed(cs, cx, cy) });
      items.push({ t: "DCT", f: () => this.beginDirect(cs) });
      items.push({ t: "XNG", f: () => this.beginCross(cs), off: this.crossCandidates(ac).length === 0 });
      if (ac.departure) items.push({ t: "EXIT", f: cmd({ k: "direct", fix: "EXIT" }), off: !ac.departure.exitFix });
      else items.push({ t: "APP", f: () => this.openApproach(cs, cx, cy) });
      items.push({ t: "HO", f: cmd({ k: "handoff" }), off: commandRefusal({ k: "handoff" }, ac) !== null });
      items.push({ t: "MAINT", f: cmd({ k: "maintain" }), small: true });
      items.push({ t: "OWN", f: cmd({ k: "resumeNavigation" }), small: true, off: sim.resumeRoute(ac).length === 0 });
    }
    if (!ac.handedToTower) {
      const running = sim.macroRuns.has(cs);
      items.push({ t: "MAC", f: () => this.openMacroPicker(cs, cx, cy), small: true, off: !running && this.macrosFor(ac).length === 0 });
    }
    const n = items.length;
    items.forEach((it, i) => {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      const r = it.small ? 84 : 70;
      const b = document.createElement("button");
      b.textContent = it.t;
      if (it.small) b.classList.add("small");
      if (it.off) b.classList.add("disabled");
      b.style.left = Math.cos(a) * r + "px";
      b.style.top = Math.sin(a) * r + "px";
      b.addEventListener("click", (e) => { e.stopPropagation(); it.f(); });
      el.appendChild(b);
    });
    el.classList.remove("hidden");
  }

  closeRadial(): void {
    $("radial").classList.add("hidden");
    $("picker").classList.add("hidden");
  }

  private openPicker(title: string, x: number, y: number, build: (el: HTMLElement) => void): void {
    $("radial").classList.add("hidden");
    const el = $("picker");
    el.innerHTML = `<div class="ph">${esc(title)}</div>`;
    build(el);
    el.classList.remove("hidden");
    const size = this.scope.size;
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.min(Math.max(8, x + 20), size.w - w - 8) + "px";
    el.style.top = Math.min(Math.max(8, y - h / 2), size.h - h - 8) + "px";
    el.querySelector<HTMLElement>(".cur")?.scrollIntoView({ block: "center" });
  }

  private pickerButton(el: HTMLElement, text: string, onClick: () => void, cls = ""): void {
    const b = document.createElement("button");
    b.textContent = text;
    if (cls) b.className = cls;
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    el.appendChild(b);
  }

  private openAltitude(cs: string, x: number, y: number): void {
    const ac = this.sim?.aircraft.find((a) => a.callsign === cs);
    if (!ac || !this.airport) return;
    const ta = this.airport.transitionAltitudeFt;
    const ceiling = Math.min(ac.type?.ceilingFt ?? 41000, ac.departure ? 41000 : Math.max(this.settings.areaCeilingFt, 15000));
    const floor = ac.effectiveLevelFloorFt;
    const current = round(ac.altitudeFt / 1000) * 1000;
    const plan = ac.departure?.expectedLevelFt;
    this.openPicker(`${cs} ALTITUDE`, x, y, (el) => {
      for (let ft = Math.floor(ceiling / 1000) * 1000; ft >= floor; ft -= 1000) {
        if (Math.abs(ft - ac.altitudeFt) < 50) continue;
        const label = ft > ta ? `FL${pad3(ft / 100)}` : `${ft} ft`;
        const cls = [ft === round(ac.targetAltitudeFt / 1000) * 1000 ? "cur" : "", ft === plan ? "plan" : ""].join(" ").trim();
        this.pickerButton(el, (ft > ac.altitudeFt ? "↑ " : "↓ ") + label, () => {
          this.addChip(cs, ft > ac.altitudeFt ? { k: "climb", feet: ft } : { k: "descend", feet: ft });
        }, cls);
      }
      void current;
    });
  }

  private openSpeed(cs: string, x: number, y: number): void {
    const ac = this.sim?.aircraft.find((a) => a.callsign === cs);
    if (!ac) return;
    const t = ac.type;
    const lo = t?.minSpeedKt ?? 120, hi = Math.min(t?.maxSpeedKt ?? 350, 300);
    this.openPicker(`${cs} SPEED`, x, y, (el) => {
      for (let k = Math.floor(hi / 10) * 10; k >= Math.ceil(lo / 10) * 10; k -= 10) {
        this.pickerButton(el, `${k} kt`, () => {
          this.addChip(cs, { k: "speed", knots: k });
        }, k === round(ac.targetSpeedKt / 10) * 10 ? "cur" : "");
      }
    });
  }

  private openApproach(cs: string, x: number, y: number): void {
    const sim = this.sim;
    const ac = sim?.aircraft.find((a) => a.callsign === cs);
    if (!sim || !ac || !this.airport) return;
    const open = this.airport.runways.filter((r) => sim.openRunways.has(r.id));
    this.openPicker(`${cs} APPROACH`, x, y, (el) => {
      for (const r of open) {
        this.pickerButton(el, `${r.ils ? "ILS" : "VIS"} ${r.id}`, () => {
          this.addChip(cs, { k: "approach", runway: r.id });
        });
        for (const c of runwayChoices(ac, r.id, this.joins, this.fixPositions).slice(0, 3)) {
          this.pickerButton(el, `${c.onRoute ? "• " : ""}${c.join.procedure} ${round(c.distanceNM)} NM`, () => {
            this.addChip(cs, { k: "joinApproach", procedure: c.join.procedure, runway: c.join.runway, via: c.join.via });
          }, "sub");
        }
      }
      if (open.length === 0) el.insertAdjacentHTML("beforeend", `<div class="ph">No runway open</div>`);
    });
  }

  private openMacroPicker(cs: string, x: number, y: number): void {
    const sim = this.sim;
    const ac = sim?.aircraft.find((a) => a.callsign === cs);
    if (!sim || !ac) return;
    this.openPicker(`${cs} MACRO`, x, y, (el) => {
      const run = sim.macroRuns.get(cs);
      if (run) this.pickerButton(el, `\u25A0 stop ${runTagText(run).slice(2)}`, () => { this.closeRadial(); this.cancelMacro(cs); }, "cur");
      for (const m of this.macrosFor(ac)) {
        const bad = "error" in this.compile(m);
        this.pickerButton(el, `${m.name}${bad ? "  !" : ""}`, () => { this.closeRadial(); this.runMacro(m.name, cs); });
      }
      this.pickerButton(el, "edit macros\u2026", () => { this.closeRadial(); openMacros(this); }, "sub");
    });
  }

  private beginHeading(cs: string): void {
    this.closeRadial();
    this.scope.mode = { kind: "heading", callsign: cs };
    this.notice(`${cs}: point and click a heading (Alt-click turns the long way), Esc cancels`, 6000);
  }

  /** Fixes a crossing restriction can go on: the route in the chips if there is one, otherwise the aircraft's own route. */
  private crossCandidates(ac: { callsign: string; route: { id: string }[]; routeIndex: number }): string[] {
    const list = this.chips && this.chips.callsign === ac.callsign ? this.chips.commands : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      if (c.k === "direct") return [c.fix];
      if (c.k === "route") return c.fixes;
    }
    return ac.route.slice(ac.routeIndex).map((p) => p.id);
  }

  private beginCross(cs: string): void {
    const ac = this.sim?.aircraft.find((a) => a.callsign === cs);
    if (!ac) return;
    const candidates = this.crossCandidates(ac);
    this.closeRadial();
    if (candidates.length === 0) { this.notice(`${cs} has no route to put a crossing on`, 4000); return; }
    this.scope.mode = { kind: "cross", callsign: cs, candidates };
    this.notice(`${cs}: click a highlighted fix to cross at an altitude, Esc cancels`, 12000);
  }

  private openCrossAltitude(cs: string, fix: string): void {
    const ac = this.sim?.aircraft.find((a) => a.callsign === cs);
    if (!ac || !this.airport) return;
    const ta = this.airport.transitionAltitudeFt;
    const ceiling = Math.min(ac.type?.ceilingFt ?? 41000, ac.departure ? 41000 : Math.max(this.settings.areaCeilingFt, 15000));
    const floor = ac.effectiveLevelFloorFt;
    const p = this.scope.screenOf(ac);
    this.endMode();
    this.openPicker(`${cs} CROSS ${fix}`, p.x, p.y, (el) => {
      for (let ft = Math.floor(ceiling / 1000) * 1000; ft >= Math.ceil(floor / 1000) * 1000; ft -= 1000) {
        const label = ft > ta ? `FL${pad3(ft / 100)}` : `${ft} ft`;
        this.pickerButton(el, label, () => this.addChip(cs, { k: "cross", fix, altitudeFt: ft }),
          Math.abs(ft - ac.altitudeFt) < 500 ? "cur" : "");
      }
    });
  }

  private beginDirect(cs: string): void {
    this.closeRadial();
    this.pendingRoute = [];
    this.scope.pendingRoute = this.pendingRoute;
    this.scope.mode = { kind: "direct", callsign: cs };
    this.notice(`${cs}: click fixes in order, then click the last one again or press Enter. Esc cancels`, 12000);
  }

  // MARK: Chips (commands collected before they are sent)

  chips: { callsign: string; commands: Command[] } | null = null;
  private pendingRoute: string[] = [];

  /** Collects a command as a chip if the aircraft would accept it; a second one of the same kind replaces the first. */
  addChip(cs: string, c: Command): void {
    const ac = this.sim?.aircraft.find((a) => a.callsign === cs);
    if (!ac) return;
    const reason = commandRefusal(c, ac);
    if (reason) { this.notice(`${cs}: unable, ${reason}`, 4000); return; }
    if (!this.chips || this.chips.callsign !== cs) this.chips = { callsign: cs, commands: [] };
    const list = this.chips.commands;
    const i = list.findIndex((x) => commandSlot(x) === commandSlot(c));
    if (i >= 0) list[i] = c; else list.push(c);
    this.endMode();
    this.renderChips();
    this.openRadial(cs, 0, 0);
  }

  private pickRouteFix(cs: string, fix: string): void {
    if (this.pendingRoute[this.pendingRoute.length - 1] === fix) { this.commitRoute(cs); return; }
    this.pendingRoute.push(fix);
    this.scope.pendingRoute = this.pendingRoute;
    this.notice(`${cs}: ${this.pendingRoute.join(" › ")}  (click the last fix again or press Enter to finish)`, 12000);
  }

  private commitRoute(cs: string): void {
    const fixes = this.pendingRoute.slice();
    this.clearPending();
    if (fixes.length === 0) { this.endMode(); return; }
    this.addChip(cs, fixes.length === 1 ? { k: "direct", fix: fixes[0] } : { k: "route", fixes });
  }

  private clearPending(): void {
    this.pendingRoute = [];
    this.scope.pendingRoute = this.pendingRoute;
  }

  sendChips(): void {
    const ch = this.chips;
    if (!ch || ch.commands.length === 0) return;
    this.chips = null;
    this.renderChips();
    this.closeRadial();
    this.send(ch.commands.map((command) => ({ callsign: ch.callsign, command })));
  }

  cancelChips(): void {
    this.chips = null;
    this.renderChips();
  }

  private renderChips(): void {
    const el = $("chips");
    const ch = this.chips;
    if (!ch || ch.commands.length === 0) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    el.innerHTML = `<div class="ph">${esc(ch.callsign)}</div>`;
    ch.commands.forEach((c, i) => {
      const b = document.createElement("button");
      b.className = "chip";
      b.innerHTML = `<span>${esc(chipLabel(c))}</span><span class="x">\u2715</span>`;
      b.title = "Click to remove";
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        ch.commands.splice(i, 1);
        if (ch.commands.length === 0) this.chips = null;
        this.renderChips();
      });
      el.appendChild(b);
    });
    const row = document.createElement("div");
    row.className = "chiprow";
    const send = document.createElement("button");
    send.className = "send";
    send.textContent = "SEND \u21B5";
    send.addEventListener("click", (e) => { e.stopPropagation(); this.sendChips(); });
    const cancel = document.createElement("button");
    cancel.textContent = "CANCEL";
    cancel.addEventListener("click", (e) => { e.stopPropagation(); this.cancelChips(); });
    row.append(send, cancel);
    el.appendChild(row);
    el.classList.remove("hidden");
    this.placeChips();
  }

  /** Keeps the chip strip beside its aircraft; drops it if the aircraft has gone. */
  private placeChips(): void {
    const ch = this.chips;
    if (!ch) return;
    const ac = this.sim?.aircraft.find((a) => a.callsign === ch.callsign);
    if (!ac || ac.handedToTower) { this.chips = null; this.renderChips(); return; }
    const el = $("chips");
    const p = this.scope.screenOf(ac);
    const size = this.scope.size;
    el.style.left = Math.min(Math.max(8, p.x + 120), size.w - el.offsetWidth - 8) + "px";
    el.style.top = Math.min(Math.max(8, p.y - el.offsetHeight / 2), size.h - el.offsetHeight - 8) + "px";
  }

  private pickHeading(cs: string, deg: number, invert: boolean): void {
    const ac = this.sim?.aircraft.find((a) => a.callsign === cs);
    this.endMode();
    if (!ac) return;
    let turn: "left" | "right" | null = null;
    if (invert) {
      let d = (deg - ac.headingDeg) % 360;
      if (d > 180) d -= 360; else if (d <= -180) d += 360;
      turn = d > 0 ? "left" : "right";
    }
    this.addChip(cs, { k: "heading", degrees: deg, turn });
  }

  endMode(): void {
    this.scope.mode = { kind: "none" };
    this.clearPending();
    const n = $("notice");
    if (n.textContent?.includes("Esc cancels")) n.classList.add("hidden");
  }

  // MARK: UI wiring

  private bindUI(): void {
    const cmd = $<HTMLInputElement>("cmd");
    cmd.addEventListener("input", () => this.updatePreview());
    cmd.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this.submitCommand(); }
      else if (e.key === "Tab") {
        e.preventDefault();
        const out = tabComplete(cmd.value, this.sim?.aircraft ?? [], this.tab);
        if (out !== null) { cmd.value = out; this.updatePreview(); }
      } else if (e.key === "Escape") {
        if (cmd.value) cmd.value = "";
        else { this.select(null); cmd.blur(); }
        this.endMode();
        this.closeRadial();
        this.updatePreview();
      } else if (e.key === "ArrowUp") {
        if (this.history.length) {
          e.preventDefault();
          this.historyIndex = Math.min(this.history.length - 1, this.historyIndex + 1);
          cmd.value = this.history[this.historyIndex];
          this.updatePreview();
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.historyIndex = Math.max(-1, this.historyIndex - 1);
        cmd.value = this.historyIndex >= 0 ? this.history[this.historyIndex] : "";
        this.updatePreview();
      }
    });
    $("cmd-send").addEventListener("click", () => this.submitCommand());

    document.addEventListener("keydown", (e) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA" || document.querySelector("dialog[open]")) return;
      if (e.key === " ") { e.preventDefault(); this.toggleRun(); }
      else if (e.key === "Enter") {
        if (this.scope.mode.kind === "direct") { e.preventDefault(); this.commitRoute(this.scope.mode.callsign); }
        else if (this.chips) { e.preventDefault(); this.sendChips(); }
      } else if (e.key === "Escape") {
        if (this.scope.mode.kind === "direct" && this.pendingRoute.length) this.clearPending();
        else if (this.scope.mode.kind === "none" && $("radial").classList.contains("hidden") && this.chips) this.cancelChips();
        else { this.endMode(); this.closeRadial(); this.select(null); }
      }
      else if (e.key === "+" || e.key === "=") this.scope.zoom(1.25);
      else if (e.key === "-" || e.key === "_") this.scope.zoom(0.8);
      else if (e.key === "?") openHelp(this);
      else if (e.key === "Home") this.fitScope();
      else if (e.key.length === 1 && /[a-z0-9]/i.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        cmd.focus(); // typing anywhere goes to the command bar
      }
    });

    $("stage").addEventListener("pointerdown", (e) => {
      if (!(e.target as HTMLElement).closest(".radial, .picker, .chips")) this.closeRadial();
    }, true);

    $("btn-run").addEventListener("click", () => this.toggleRun());
    const speed = $<HTMLInputElement>("speed");
    speed.addEventListener("input", () => {
      this.speed = Number(speed.value);
      $("speed-label").textContent = this.speed + "x";
    });
    $("zoom-in").addEventListener("click", () => this.scope.zoom(1.25));
    $("zoom-out").addEventListener("click", () => this.scope.zoom(0.8));
    $("zoom-fit").addEventListener("click", () => this.fitScope());
    document.querySelectorAll<HTMLButtonElement>("[data-layer]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.layer as "star" | "sid" | "app" | "fix";
      this.settings.layers[k] = !this.settings.layers[k];
      saveSettings(this.settings);
      this.applyLayers();
    }));
    document.querySelectorAll<HTMLButtonElement>("[data-panel]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.panel as "strips" | "radio" | "info" | "runways";
      const narrow = window.innerWidth < 760;
      const turnOn = !this.settings.panels[k];
      if (narrow && turnOn) for (const o of ["strips", "radio", "info", "runways"] as const) this.settings.panels[o] = false;
      this.settings.panels[k] = turnOn;
      saveSettings(this.settings);
      this.applyPanels();
      this.renderPanels(true);
    }));
    $("btn-airport").addEventListener("click", () => openAirportDialog(this));
    $("btn-settings").addEventListener("click", () => openSettings(this));
    $("btn-help").addEventListener("click", () => openHelp(this));
    $("btn-macros").addEventListener("click", () => openMacros(this));
    $("runway-canvas").addEventListener("click", (e) => {
      const sim = this.sim;
      if (!sim) return;
      const r = (e.target as HTMLElement).getBoundingClientRect();
      const hit = this.runwayMap.hit(sim, e.clientX - r.left, e.clientY - r.top);
      if (hit) this.select(hit);
    });
    $("btn-end").addEventListener("click", () => this.endSession());

    $("strip-list").addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const btn = t.closest<HTMLElement>("[data-cmd]");
      const strip = t.closest<HTMLElement>("[data-cs]");
      if (!strip) return;
      const cs = strip.dataset.cs!;
      if (btn) {
        const code = btn.dataset.cmd!;
        const r = evaluate(`${cs} ${code}`, this.evalContext());
        if (r.status === "ready") this.send(r.issuedAll);
        else this.notice(r.message, 3500);
        return;
      }
      this.select(cs === this.selected ? null : cs);
      const ac = this.sim?.aircraft.find((a) => a.callsign === cs);
      if (ac && cs === this.selected && window.innerWidth >= 760) {
        const p = this.scope.screenOf(ac);
        const s = this.scope.size;
        if (p.x < 0 || p.y < 0 || p.x > s.w || p.y > s.h) this.scope.centreOn(ac.eastNM, ac.northNM);
      }
    });
    $("radio-list").addEventListener("click", (e) => {
      const m = (e.target as HTMLElement).closest<HTMLElement>("[data-cs]");
      if (m) this.select(m.dataset.cs!);
    });
    this.updatePreview();
  }

  applyLayers(): void {
    for (const k of ["star", "sid", "app", "fix"] as const) $(`layer-${k}`).classList.toggle("on", this.settings.layers[k]);
  }

  applyPanels(): void {
    for (const k of ["strips", "radio", "info", "runways"] as const) {
      $(k).classList.toggle("hidden", !this.settings.panels[k]);
      $(`panel-${k}`).classList.toggle("on", this.settings.panels[k]);
    }
  }

  toggleRun(): void {
    this.running = !this.running;
    this.updateRunButton();
  }

  private updateRunButton(): void {
    const b = $("btn-run");
    b.textContent = this.running ? "❚❚" : "▶";
    b.classList.toggle("on", !this.running);
    b.title = this.running ? "Pause (Space)" : "Run (Space)";
  }

  endSession(): void {
    const sim = this.sim;
    if (!sim) return;
    this.running = false;
    this.updateRunButton();
    openDebrief(this, sim.endSession());
  }

  resumeSession(): void {
    this.sim?.resumeSession();
    this.running = true;
    this.updateRunButton();
  }

  /** Applies changed settings to the running session where that is possible. */
  settingsChanged(restartWeather: boolean): void {
    const sim = this.sim;
    saveSettings(this.settings);
    applyScheme(scheme(this.settings.scheme));
    setNumberStyle(this.settings.numberStyle);
    if (!sim) return;
    sim.traffic = { ...this.settings.traffic };
    sim.events = { ...this.settings.events };
    sim.areaRadiusNM = this.settings.areaRadiusNM;
    sim.areaCeilingFt = this.settings.areaCeilingFt;
    if (restartWeather) {
      sim.weatherMode = this.settings.weatherMode;
      this.startWeather(false);
    }
    this.applyLayers();
    this.renderPanels(true);
  }

  notice(text: string, ms = 4000): void {
    const n = $("notice");
    n.textContent = text;
    n.classList.remove("hidden");
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => n.classList.add("hidden"), ms);
  }

  // MARK: Speech

  private speakNew(): void {
    const sim = this.sim;
    if (!sim) return;
    const log = sim.radioLog;
    const newest = log.length ? log[log.length - 1].id : -1;
    if (!this.settings.speech || !("speechSynthesis" in window)) { this.lastSpoken = newest; return; }
    for (const m of log) {
      if (m.id <= this.lastSpoken) continue;
      if (m.speaker === "system") continue;
      const u = new SpeechSynthesisUtterance(m.text);
      u.rate = 1.15;
      u.pitch = m.speaker === "pilot" ? 0.9 : 1.05;
      speechSynthesis.speak(u);
    }
    this.lastSpoken = newest;
  }

  // MARK: Panels

  renderPanels(force: boolean): void {
    const sim = this.sim;
    if (!sim) return;
    const t = sim.tickCount;
    $("clock").textContent = `${pad2(Math.trunc(t / 3600))}:${pad2(Math.trunc(t / 60) % 60)}:${pad2(t % 60)}`;
    const sc = sim.score;
    const chip = $("score-chip");
    chip.textContent = `SCORE ${sc.total}${sc.grade ? " " + sc.grade : ""}`;
    if (sc.total !== this.lastScoreTotal) {
      const last = sc.events[sc.events.length - 1];
      this.lastScoreText = last ? `${last.points >= 0 ? "+" : "−"}${Math.abs(last.points)} ${last.kind}` : "";
      this.lastScoreTotal = sc.total;
    }
    if (this.settings.panels.strips || force) this.renderStrips(sim);
    if (this.settings.panels.radio || force) this.renderRadio(sim);
    if (this.settings.panels.info || force) this.renderInfo(sim);
  }

  private renderStrips(sim: Simulation): void {
    const arrivals = sim.aircraft.filter((a) => !a.departure);
    const deps = sim.aircraft.filter((a) => a.departure);
    $("strip-count").textContent = `${arrivals.length} arr · ${deps.length} dep`;
    const ta = sim.transitionAltitudeFt;
    const lvl = (ft: number) => (ft > ta ? `FL${pad3(round(ft / 100))}` : `${round(ft / 100) * 100}`);
    const strip = (ac: Aircraft) => {
      const sel = ac.callsign === this.selected ? " sel" : "";
      if (ac.handedToTower) return `<div class="strip twr${sel}" data-cs="${ac.callsign}"><span class="cs">${ac.callsign}</span><span class="r">TWR</span></div>`;
      const hist = sim.commandHistory.get(ac.callsign);
      const last = hist?.[hist.length - 1];
      const pending = sim.hasPending(ac.callsign);
      const type = aircraftType(ac.typeCode);
      const cls = ["strip", ac.departure ? "dep" : "", ac.emergency ? "emerg" : ""].join(" ") + sel;
      const alt = ac.isOnGround ? (ac.groundPhase === "takeoffRoll" ? "ROLL" : ac.groundPhase === "linedUp" ? "LINED UP" : "HOLDING") :
        `${lvl(ac.altitudeFt)}${Math.abs(ac.targetAltitudeFt - ac.altitudeFt) > 50 ? (ac.targetAltitudeFt > ac.altitudeFt ? " ↑" : " ↓") + lvl(ac.targetAltitudeFt) : ""}`;
      let extra = "";
      if (ac.departure) {
        const d = ac.departure;
        extra = `<span class="ty">${d.runway} ${d.sid ? d.sid.split(".")[0] : "RWY HDG"}${d.exitFix ? " → " + d.exitFix : ""}</span><span class="r">plan ${lvl(d.expectedLevelFt)} · HO ${lvl(d.handoffAltitudeFt)}</span>`;
      } else {
        extra = `<span class="ty">${ac.procedureId ? esc(ac.procedureId.split(".")[0]) : ""}</span><span class="r">${ac.navLabel}</span>`;
      }
      let btns = "";
      if (sel) {
        if (ac.groundPhase === "holdingShort") btns = `<button class="tb" data-cmd="lu">LINE UP</button><button class="tb" data-cmd="to">TAKE-OFF</button>`;
        else if (ac.groundPhase === "linedUp") btns = `<button class="tb" data-cmd="to">TAKE-OFF</button>`;
        else if (!ac.isOnGround) {
          if (ac.departure) btns = `<button class="tb" data-cmd="p exit">DCT EXIT</button><button class="tb" data-cmd="c${ac.departure.expectedLevelFt / 100}">PLAN LVL</button><button class="tb" data-cmd="ho">HANDOFF</button>`;
          else {
            const open = [...sim.openRunways].sort();
            btns = open.map((r) => `<button class="tb" data-cmd="i${r.toLowerCase()}">${sim.isVisualRunway(r) ? "VIS" : "ILS"} ${r}</button>`).join("") +
              `<button class="tb" data-cmd="ho">TWR</button>`;
          }
        }
      }
      return `<div class="${cls}" data-cs="${ac.callsign}">
        <span><span class="cs">${ac.callsign}</span> <span class="ty">${type?.code ?? ""}${type ? "/" + type.wake : ""}</span>${ac.emergency ? ' <span class="neg">EMERG</span>' : ""}</span>
        <span class="r">${ac.isOnGround ? "" : pad3(round(ac.speedKt)) + "kt"}</span>
        <span>${alt}</span><span class="r">${ac.isOnGround ? "" : "HDG " + pad3(round(ac.headingDeg) || 360)}</span>
        ${extra}
        ${sim.macroRuns.has(ac.callsign) ? `<span class="mac">${esc(runTagText(sim.macroRuns.get(ac.callsign)!))}</span>` : ""}
        ${last ? `<span class="last${pending ? " pending" : ""}">${esc(chipLabel(last.command))}${pending ? " …" : ""}</span>` : ""}
        ${btns ? `<div class="btns">${btns}</div>` : ""}
      </div>`;
    };
    const order = (a: Aircraft, b: Aircraft) => Number(a.handedToTower) - Number(b.handedToTower) ||
      Math.hypot(a.eastNM, a.northNM) - Math.hypot(b.eastNM, b.northNM);
    const html = `<div class="strip-head">ARRIVALS</div>${arrivals.sort(order).map(strip).join("") || '<div class="strip dim">none</div>'}
      <div class="strip-head">DEPARTURES</div>${deps.sort((a, b) => Number(!a.isOnGround) - Number(!b.isOnGround) || a.callsign.localeCompare(b.callsign)).map(strip).join("") || '<div class="strip dim">none</div>'}`;
    const list = $("strip-list");
    if (list.dataset.html !== html) {
      const top = list.scrollTop;
      list.innerHTML = html;
      list.dataset.html = html;
      list.scrollTop = top;
    }
  }

  private renderRadio(sim: Simulation): void {
    const list = $("radio-list");
    const msgs = sim.radioLog.slice(-120);
    const key = `${msgs[msgs.length - 1]?.id ?? -1}|${this.selected}`;
    if (list.dataset.key === key) return;
    list.dataset.key = key;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const cls = (m: RadioMessage) => {
      const c = ["msg", m.speaker];
      if (m.tag) c.push(tagSeverity(m.tag));
      else if (m.speaker === "system" && /landed|handed|established|airborne/.test(m.text)) c.push("good");
      if (this.selected && m.callsign === this.selected) c.push("hl");
      return c.join(" ");
    };
    list.innerHTML = msgs.map((m) => {
      const ts = `${pad2(Math.trunc(m.tick / 60) % 60)}:${pad2(m.tick % 60)}`;
      return `<div class="${cls(m)}"${m.callsign ? ` data-cs="${m.callsign}"` : ""}><span class="t">${ts}</span>${m.tag ? `<span class="tag">${m.tag}</span>` : ""}${esc(m.text)}${m.code ? `<span class="code">&gt; ${esc(m.code)}</span>` : ""}</div>`;
    }).join("");
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  private renderInfo(sim: Simulation): void {
    const a = this.airport!;
    const open = sim.runwayStatuses.filter((s) => s.isOpen);
    const closed = sim.runwayStatuses.filter((s) => !s.isOpen);
    const kt = (x: number) => `${round(Math.abs(x))}`;
    const sc = sim.score;
    const conflicts = sim.conflicts.slice(0, 6).map((c) =>
      `<div class="${c.kind === "loss" ? "bad" : "warn"}">${c.kind === "loss" ? "LOSS" : "CONFLICT"} ${c.first}/${c.second} ${c.kind === "loss" ? "" : "in " + c.secondsToLoss + "s"} ${c.lateralNM.toFixed(1)}NM ${round(c.verticalFt)}ft</div>`).join("");
    const html = `
      <div class="info-sec"><div><b>${esc(a.name)}</b></div>
        <div><span class="k">ELEV</span>${a.elevationFt ?? "?"} ft <span class="k" style="min-width:0;margin-left:10px">TA</span> ${a.transitionAltitudeFt} ft</div>
        <div><span class="k">MIN ALT</span>${sim.levelFloorFt} ft, ${sim.approachLevelFloorFt} ft cleared app</div>
        ${open.map((s) => `<div class="open">RWY ${s.id} ${s.headwindKt >= 0 ? "head" : "tail"} ${kt(s.headwindKt)} · cross ${kt(s.crosswindKt)} kt${sim.isVisualRunway(s.id) ? " · VIS" : ""}</div>`).join("")}
        ${closed.length ? `<div class="closed">closed: ${closed.map((s) => `${s.id} (${esc(s.reason)})`).join(", ")}</div>` : ""}
      </div>
      <div class="info-sec"><div><span class="k">WIND</span><b>${sim.wind.text}</b> kt</div>
        <div><span class="k">SOURCE</span>${esc(this.windSource)} (${WEATHER_MODE_TITLES[this.settings.weatherMode]})</div>
        ${sim.liveReport?.raw ? `<div class="dim" style="font-size:10px">${esc(sim.liveReport.raw)}</div>` : ""}
        ${this.nextWeather ? `<div class="dim">next update ${this.nextWeather.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>` : ""}
      </div>
      <div class="info-sec"><div><span class="k">TRAF</span>${sim.trafficRatesText || "off"}</div>
        <div><span class="k">SEED</span>${this.trafficSeed.toString(16).slice(0, 8)}${this.settings.traffic.fixedSeed ? " (fixed)" : ""}</div></div>
      <div class="info-sec"><div><span class="k">SCORE</span><b>${sc.total}</b> ×${sc.multiplier.toFixed(2)}${sc.grade ? ` · grade ${sc.grade}` : ""}</div>
        <div><span class="k">LAST</span>${esc(this.lastScoreText)}</div>
        <div><span class="k">HANDLED</span>${sc.arrivalsHandled} arr · ${sc.departuresHandled} dep</div></div>
      <div class="info-sec"><div><span class="k">SEP</span>${sim.conflicts.length ? "" : '<span class="open">no conflicts</span>'} losses ${sim.lossOfSeparationCount}</div>${conflicts}</div>`;
    const el = $("info-body");
    if (el.dataset.html !== html) {
      el.innerHTML = html;
      el.dataset.html = html;
    }
  }
}

function chainLabel(c: Command): string {
  return commandCode(c);
}

const app = new App();
(window as unknown as { flightcatcher: App }).flightcatcher = app;

// Service worker: offline app shell. When a new version is deployed, offer a reload rather than switching mid-game.
const updateSW = registerSW({
  onNeedRefresh() {
    const t = $("update-toast");
    t.innerHTML = `<span>A new version is ready.</span><button class="tb primary" id="sw-reload">Reload</button><button class="tb" id="sw-later">Later</button>`;
    t.classList.remove("hidden");
    $("sw-reload").addEventListener("click", () => void updateSW(true));
    $("sw-later").addEventListener("click", () => t.classList.add("hidden"));
  },
  onOfflineReady() {
    app.notice("Ready to work offline (12 airports included; download more from the airport list)", 5000);
  },
});
