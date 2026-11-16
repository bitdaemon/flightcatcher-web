// Dialogs: airport list with offline downloads, settings, the command and scoring reference, and the debrief.
import type { App } from "../main";
import { airportTitle, entryMatches, entrySubtitle, type AirportIndexEntry } from "../sim/airport";
import { CATEGORY_TITLE, GRADE_RANK, KIND_TITLE, SCORE_CATEGORIES, ScoreRules, scoreEventText, type ScoreCard, type ScoreKind } from "../sim/scoring";
import { applyPreset, TRAFFIC_PRESETS, VARIATION_TITLE, type TrafficVariation } from "../sim/traffic";
import { ALL_CATEGORIES, AIRCRAFT_TYPES, CATEGORY_TITLES, type AircraftCategory } from "../sim/types";
import { WEATHER_MODE_TITLES, type WeatherMode } from "../sim/weather";
import { downloadAll, formatBytes, offlineAirports, removeDownloads, requestPersistence, storageEstimate } from "../data/airports";
import { addScore, loadScores, type ScoreRecord } from "../data/settings";
import { SCHEMES } from "./theme";
import { pad2 } from "../sim/util";
import { MACRO_EXAMPLES, macroErrorText, PHASE_LABEL, phaseOf, triggerLabel, type Macro, type MacroPhase } from "../sim/macro";
import { commandCode } from "../sim/command";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function dialog(id: string, title: string, body: string, footer = ""): HTMLDialogElement {
  const d = document.getElementById(id) as HTMLDialogElement;
  d.innerHTML = `<div class="dh"><h1>${title}</h1><button class="tb" data-close>✕</button></div><div class="db">${body}</div>${footer ? `<div class="df">${footer}</div>` : ""}`;
  d.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => d.close()));
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
  if (!d.open) d.showModal();
  return d;
}

// MARK: Airport list and offline downloads

let downloadCtrl: AbortController | null = null;

export async function openAirportDialog(app: App): Promise<void> {
  const index = app.index;
  const offline = await offlineAirports(index);
  const notBundled = index.filter((e) => !e.bundled);
  const restBytes = notBundled.reduce((s, e) => s + (e.bytes ?? 0), 0);
  const body = `
    <input class="search" id="ap-q" placeholder="Search by city, airport name, ICAO or IATA code" autocomplete="off" />
    <div class="row" style="margin-top:8px">
      <label style="min-width:0"><input type="checkbox" id="ap-offline-only" /> only airports available offline</label>
      <span class="grow"></span><span class="dim mono" id="ap-count"></span>
    </div>
    <div class="ap-list" id="ap-list"></div>
    <div class="dl-box">
      <div class="row" style="margin:0"><b style="flex:1">Offline airports</b><span class="mono dim" id="dl-status"></span></div>
      <p class="dim" style="margin:4px 0 8px">The ${index.filter((e) => e.bundled).length} busiest airports are included with the app. The other ${notBundled.length}
        (${formatBytes(restBytes)}) load from the web the first time you pick them. Download them all now to play any airport without a connection.</p>
      <progress id="dl-progress" value="0" max="1" class="hidden"></progress>
      <div class="row">
        <button class="tb primary" id="dl-all">Download all for offline use</button>
        <button class="tb hidden" id="dl-cancel">Cancel</button>
        <button class="tb" id="dl-remove">Remove downloads</button>
        <span class="grow"></span><span class="dim mono" id="dl-storage"></span>
      </div>
    </div>`;
  const d = dialog("dlg-airport", "Choose airport", body);
  const q = d.querySelector<HTMLInputElement>("#ap-q")!;
  const list = d.querySelector<HTMLElement>("#ap-list")!;
  const onlyOffline = d.querySelector<HTMLInputElement>("#ap-offline-only")!;
  let have = offline;

  const render = () => {
    const query = q.value;
    const rows = index.filter((e) => entryMatches(e, query) && (!onlyOffline.checked || have.has(e.icao)));
    // The bundled ones first when there is no search, so the 12 core airports are easy to find.
    if (!query) rows.sort((a, b) => Number(!!b.bundled) - Number(!!a.bundled));
    d.querySelector("#ap-count")!.textContent = `${rows.length} of ${index.length}`;
    list.innerHTML = rows.slice(0, 300).map((e) => {
      const isOffline = have.has(e.icao);
      const unavailable = !isOffline && !navigator.onLine;
      const badge = e.bundled ? '<span class="core">★ included</span>' : isOffline ? '<span class="on">✓ offline</span>' : `☁ ${formatBytes(e.bytes ?? 0)}`;
      const feats = [`${e.approaches} app`, e.stars ? `${e.stars} STAR` : "no STAR", e.sids ? `${e.sids} SID` : "no SID"].join(" · ");
      return `<div class="ap${e.icao === app.airport?.icao ? " cur" : ""}${unavailable ? " unavailable" : ""}" data-icao="${e.icao}">
        <span class="t">${esc(airportTitle(e.city, e.name, e.icao))}${e.iata ? ` <span class="dim mono">${e.iata}</span>` : ""}</span>
        <span class="b">${badge}<br>${feats}</span>
        <span class="s">${esc(entrySubtitle(e))}</span></div>`;
    }).join("");
  };
  q.addEventListener("input", render);
  onlyOffline.addEventListener("change", render);
  list.addEventListener("click", async (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-icao]");
    if (!row || row.classList.contains("unavailable")) return;
    row.style.opacity = "0.5";
    if (await app.loadAirport(row.dataset.icao!)) d.close();
    else row.style.opacity = "";
  });
  render();
  q.focus();

  const status = d.querySelector<HTMLElement>("#dl-status")!;
  const progress = d.querySelector<HTMLProgressElement>("#dl-progress")!;
  const btnAll = d.querySelector<HTMLButtonElement>("#dl-all")!;
  const btnCancel = d.querySelector<HTMLButtonElement>("#dl-cancel")!;
  const storage = d.querySelector<HTMLElement>("#dl-storage")!;
  const refreshCounts = async () => {
    have = await offlineAirports(index);
    status.textContent = `${have.size} / ${index.length} offline`;
    btnAll.disabled = have.size >= index.length || !navigator.onLine;
    btnAll.textContent = have.size >= index.length ? "All airports are offline" : "Download all for offline use";
    const est = await storageEstimate();
    storage.textContent = est ? `storage used ${formatBytes(est.usage)}` : "";
  };
  void refreshCounts();

  btnAll.addEventListener("click", async () => {
    if (!("caches" in window)) { app.notice("This browser cannot store files for offline use"); return; }
    void requestPersistence();
    downloadCtrl = new AbortController();
    btnAll.classList.add("hidden");
    btnCancel.classList.remove("hidden");
    progress.classList.remove("hidden");
    const result = await downloadAll(index, (p) => {
      progress.max = Math.max(1, p.total);
      progress.value = p.done;
      status.textContent = `downloading ${p.done} / ${p.total} · ${formatBytes(p.bytes)}`;
    }, downloadCtrl.signal);
    downloadCtrl = null;
    btnCancel.classList.add("hidden");
    btnAll.classList.remove("hidden");
    progress.classList.add("hidden");
    await refreshCounts();
    render();
    app.notice(result.failed.length ? `Downloaded with ${result.failed.length} failures: ${result.failed.slice(0, 6).join(", ")}` :
      `All ${index.length} airports are available offline`, 5000);
  });
  btnCancel.addEventListener("click", () => downloadCtrl?.abort());
  d.querySelector("#dl-remove")!.addEventListener("click", async () => {
    await removeDownloads(index, app.airport?.icao ?? null);
    await refreshCounts();
    render();
  });
}

// MARK: Settings

export function openSettings(app: App): void {
  const s = app.settings;
  const t = s.traffic;
  const e = s.events;
  const body = `
    <h3>Traffic</h3>
    <div class="row"><label>Preset</label><select id="st-preset"><option value="">Custom</option>${TRAFFIC_PRESETS.map((p, i) => `<option value="${i}">${p.name} (${p.arrivals[0]}–${p.arrivals[1]}/h)</option>`).join("")}</select>
      <label style="min-width:0"><input type="checkbox" id="st-enabled" ${t.enabled ? "checked" : ""}/> random traffic on</label></div>
    <div class="row"><label>Arrivals per hour</label><input type="number" id="st-arr-lo" min="0" max="80" value="${t.arrivalsPerHour}" style="width:70px"/> to <input type="number" id="st-arr-hi" min="0" max="80" value="${t.arrivalsMaxPerHour ?? t.arrivalsPerHour}" style="width:70px"/></div>
    <div class="row"><label>Departures per hour</label><input type="number" id="st-dep-lo" min="0" max="60" value="${t.departuresPerHour}" style="width:70px"/> to <input type="number" id="st-dep-hi" min="0" max="60" value="${t.departuresMaxPerHour ?? t.departuresPerHour}" style="width:70px"/></div>
    <div class="row"><label>Variation</label><select id="st-var">${(["steady", "moderate", "lively"] as TrafficVariation[]).map((v) => `<option value="${v}" ${t.variation === v ? "selected" : ""}>${VARIATION_TITLE[v]}</option>`).join("")}</select></div>
    <div class="row"><label>Aircraft</label><div class="checks">${ALL_CATEGORIES.filter((c) => c !== "helicopter").map((c) => `<label><input type="checkbox" data-cat="${c}" ${t.enabledCategories.includes(c) ? "checked" : ""}/> ${CATEGORY_TITLES[c]}</label>`).join("")}</div></div>
    <div class="row"><label>Types left out</label><div class="checks">${AIRCRAFT_TYPES.filter((x) => x.canFlyIFR).map((x) => `<label title="${esc(x.name)}"><input type="checkbox" data-type="${x.code}" ${t.disabledTypes.includes(x.code) ? "" : "checked"}/> ${x.code}</label>`).join("")}</div></div>
    <div class="row"><label>Fixed traffic seed</label><input type="text" id="st-seed" placeholder="empty: new traffic each session" value="${t.fixedSeed ?? ""}" style="width:220px" class="search"/></div>

    <h3>Random events (% of arrivals)</h3>
    <div class="row"><label>Pilot go-around</label><input type="range" id="ev-ga" min="0" max="20" step="1" value="${e.pilotGoAroundPercent}"/><span class="val" id="ev-ga-v"></span></div>
    <div class="row"><label>Windshear</label><input type="range" id="ev-ws" min="0" max="20" step="1" value="${e.windshearPercent}"/><span class="val" id="ev-ws-v"></span></div>
    <div class="row"><label>Emergency</label><input type="range" id="ev-em" min="0" max="20" step="1" value="${e.emergencyPercent}"/><span class="val" id="ev-em-v"></span></div>

    <h3>Weather and airspace</h3>
    <div class="row"><label>Wind</label><select id="st-weather">${(["random", "live", "fixed"] as WeatherMode[]).map((m) => `<option value="${m}" ${s.weatherMode === m ? "selected" : ""}>${WEATHER_MODE_TITLES[m]}</option>`).join("")}</select>
      <span class="dim">Live uses the NOAA METAR for the airport, when your browser can reach it.</span></div>
    <div class="row"><label>Approach area radius</label><input type="range" id="st-radius" min="25" max="60" step="5" value="${s.areaRadiusNM}"/><span class="val" id="st-radius-v"></span></div>
    <div class="row"><label>Area ceiling</label><input type="range" id="st-ceiling" min="10000" max="19000" step="1000" value="${s.areaCeilingFt}"/><span class="val" id="st-ceiling-v"></span></div>

    <h3>Display</h3>
    <div class="row"><label>Colour scheme</label><select id="st-scheme">${SCHEMES.map((x) => `<option value="${x.id}" ${s.scheme === x.id ? "selected" : ""}>${x.name}</option>`).join("")}</select></div>
    <div class="row"><label>Layers</label><div class="checks">
      ${(["star", "sid", "app", "fix", "rings", "compass"] as const).map((k) => `<label><input type="checkbox" data-layer="${k}" ${s.layers[k] ? "checked" : ""}/> ${{ star: "STARs", sid: "SIDs", app: "Approaches", fix: "Fixes", rings: "Range rings", compass: "Compass ring" }[k]}</label>`).join("")}
    </div></div>

    <h3>Radio</h3>
    <div class="row"><label>Numbers</label><select id="st-numbers"><option value="plain" ${s.numberStyle === "plain" ? "selected" : ""}>Plain (three, five, nine)</option><option value="icao" ${s.numberStyle === "icao" ? "selected" : ""}>ICAO (tree, fife, niner)</option></select></div>
    <div class="row"><label>Speak radio calls</label><label style="min-width:0"><input type="checkbox" id="st-speech" ${s.speech ? "checked" : ""}/> read controller and pilot calls aloud (browser voice)</label></div>
    <p class="dim">Traffic, events and airspace changes apply at once; a fixed seed takes effect from the next session.</p>`;
  const footer = `<button class="tb" id="st-new">New session</button><span class="grow"></span><button class="tb primary" data-close>Done</button>`;
  const d = dialog("dlg-settings", "Settings", body, footer);
  const $ = <T extends HTMLElement>(sel: string) => d.querySelector<T>(sel)!;
  const num = (sel: string) => Math.max(0, Number($<HTMLInputElement>(sel).value) || 0);

  const showVals = () => {
    $("#ev-ga-v").textContent = `${$<HTMLInputElement>("#ev-ga").value}%`;
    $("#ev-ws-v").textContent = `${$<HTMLInputElement>("#ev-ws").value}%`;
    $("#ev-em-v").textContent = `${$<HTMLInputElement>("#ev-em").value}%`;
    $("#st-radius-v").textContent = `${$<HTMLInputElement>("#st-radius").value} NM`;
    $("#st-ceiling-v").textContent = `${$<HTMLInputElement>("#st-ceiling").value} ft`;
  };
  showVals();

  const read = (restartWeather: boolean) => {
    t.enabled = $<HTMLInputElement>("#st-enabled").checked;
    t.arrivalsPerHour = num("#st-arr-lo");
    t.arrivalsMaxPerHour = Math.max(t.arrivalsPerHour, num("#st-arr-hi"));
    t.departuresPerHour = num("#st-dep-lo");
    t.departuresMaxPerHour = Math.max(t.departuresPerHour, num("#st-dep-hi"));
    t.variation = $<HTMLSelectElement>("#st-var").value as TrafficVariation;
    t.enabledCategories = [...d.querySelectorAll<HTMLInputElement>("[data-cat]")].filter((x) => x.checked).map((x) => x.dataset.cat as AircraftCategory);
    t.disabledTypes = [...d.querySelectorAll<HTMLInputElement>("[data-type]")].filter((x) => !x.checked).map((x) => x.dataset.type!);
    const seed = $<HTMLInputElement>("#st-seed").value.trim();
    t.fixedSeed = /^\d+$/.test(seed) && seed !== "0" ? seed : null;
    e.pilotGoAroundPercent = num("#ev-ga");
    e.windshearPercent = num("#ev-ws");
    e.emergencyPercent = num("#ev-em");
    s.weatherMode = $<HTMLSelectElement>("#st-weather").value as WeatherMode;
    s.areaRadiusNM = num("#st-radius");
    s.areaCeilingFt = num("#st-ceiling");
    s.scheme = $<HTMLSelectElement>("#st-scheme").value;
    d.querySelectorAll<HTMLInputElement>("[data-layer]").forEach((x) => { s.layers[x.dataset.layer as keyof typeof s.layers] = x.checked; });
    s.numberStyle = $<HTMLSelectElement>("#st-numbers").value as "plain" | "icao";
    s.speech = $<HTMLInputElement>("#st-speech").checked;
    if (!s.speech && "speechSynthesis" in window) speechSynthesis.cancel();
    showVals();
    app.settingsChanged(restartWeather);
  };
  d.querySelectorAll("input, select").forEach((el) => el.addEventListener("change", () => read((el as HTMLElement).id === "st-weather")));
  d.querySelectorAll("input[type=range]").forEach((el) => el.addEventListener("input", showVals));
  $<HTMLSelectElement>("#st-preset").addEventListener("change", (ev) => {
    const i = (ev.target as HTMLSelectElement).value;
    if (i === "") return;
    applyPreset(TRAFFIC_PRESETS[Number(i)], t);
    $<HTMLInputElement>("#st-arr-lo").value = String(t.arrivalsPerHour);
    $<HTMLInputElement>("#st-arr-hi").value = String(t.arrivalsMaxPerHour);
    $<HTMLSelectElement>("#st-var").value = t.variation;
    d.querySelectorAll<HTMLInputElement>("[data-cat]").forEach((x) => { x.checked = t.enabledCategories.includes(x.dataset.cat as AircraftCategory); });
    d.querySelectorAll<HTMLInputElement>("[data-type]").forEach((x) => { x.checked = true; });
    read(false);
  });
  $("#st-new").addEventListener("click", () => { d.close(); app.newSession(); });
}

// MARK: Help

export function openHelp(app: App): void {
  const pts = ScoreRules.points;
  const rows = (Object.keys(pts) as ScoreKind[]).map((k) => `<tr><td>${KIND_TITLE[k]}</td><td class="num ${pts[k] >= 0 ? "pos" : "neg"}">${pts[k] > 0 ? "+" : ""}${k === "efficiency" ? "up to +30" : pts[k]}</td></tr>`).join("");
  const body = `
    <p class="disclaimer"><b>This is a game, not a simulator.</b> Traffic is invented. Procedures come from FAA CIFP data but are simplified,
      and the data may be out of date. Do not use it for real-world navigation, flight planning, or controller or pilot training.</p>
    <h3>Getting started</h3>
    <p>Pick an aircraft (click it, its strip, or type part of its callsign). Type codes in the command bar and press Enter, or right-click
      (long-press on touch screens) the aircraft for its menu. Arrivals: bring them down, line them up, clear the approach, hand them to the tower once
      established. Departures: line up, clear for take-off, climb to the plan level, hand off.</p>
    <h3>Command bar</h3>
    <table>
      <tr><td><code>aal123 d70 s180 h270l</code></td><td>chain several codes for one aircraft; leave the callsign out when one is selected</td></tr>
      <tr><td><code>d70</code> / <code>c120</code></td><td>descend / climb to 7,000 / 12,000 ft (hundreds of feet)</td></tr>
      <tr><td><code>h270</code> <code>h270l</code> <code>h090r</code></td><td>heading, optionally forcing the turn direction</td></tr>
      <tr><td><code>s180</code></td><td>speed in knots</td></tr>
      <tr><td><code>i27</code></td><td>cleared ILS approach runway 27 (visual where the runway has no ILS)</td></tr>
      <tr><td><code>j27</code> <code>j27.2</code> <code>j I27.AYBEE</code></td><td>join the best (or 2nd) approach to runway 27, or a named procedure</td></tr>
      <tr><td><code>p kerav</code> <code>p kerav pizsa</code></td><td>proceed direct to a fix, or a route of fixes; <code>p exit</code> for a departure's exit fix</td></tr>
      <tr><td><code>x kerav 50</code></td><td>cross KERAV at 5,000 ft</td></tr>
      <tr><td><code>d50!</code> <code>h270!</code></td><td>expedite a level, heading or speed change</td></tr>
      <tr><td><code>m</code> / <code>own</code></td><td>maintain present state / resume own navigation</td></tr>
      <tr><td><code>lu</code> <code>to</code> <code>ho</code></td><td>line up and wait, cleared for take-off, hand off (tower for arrivals)</td></tr>
      <tr><td><code>mac SLOW</code> / <code>mac-</code></td><td>run one of the airport's macros on the aircraft / stop its macro</td></tr>
      <tr><td>Tab · ↑ · Esc</td><td>complete the callsign · previous commands · clear</td></tr>
    </table>
    <h3>Macros</h3>
    <p>Macros are saved sequences of instructions with optional triggers, kept per airport in this browser. Edit them with
      MACROS in the top bar. One step per line, codes as on the command bar:</p>
    <table>
      <tr><td><code>s210</code></td><td>sent as soon as the macro starts</td></tr>
      <tr><td><code>at CAPE: d30, s180</code></td><td>sent when the aircraft passes CAPE</td></tr>
      <tr><td><code>when alt&lt;4000: i4r</code></td><td>sent once below 4,000 ft (<code>alt&lt;40</code> works too)</td></tr>
      <tr><td><code>when spd&lt;=180: h270l</code></td><td>sent once at or below 180 kt</td></tr>
    </table>
    <p class="dim">The tag shows the next step (<code>M SLOW 2/3 A&lt;8000</code>). Your own instruction to the aircraft cancels its macro;
      a refused step stops it (<code>M!</code> on the radio), as do a go-around, an emergency or the handoff.</p>
    <h3>Runway view</h3>
    <p>RWY in the top bar shows the runways close up: green when free, yellow while an arrival is cleared to it, red while a
      departure is lined up or rolling or an arrival is about to touch down.</p>
    <h3>Keys and gestures</h3>
    <table>
      <tr><td>Space</td><td>pause / run</td></tr><tr><td>+ / − · wheel · pinch</td><td>zoom</td></tr>
      <tr><td>drag</td><td>pan the scope; drag a tag to move it</td></tr><tr><td>Esc</td><td>cancel the pick or clear the selection</td></tr>
      <tr><td>any letter</td><td>starts typing in the command bar</td></tr>
    </table>
    <h3>Rules of thumb</h3>
    <p>Separation: 3 NM or 1,000 ft. Amber lines are predicted conflicts, red ones are losses. Intercept the localiser at 30° or less,
      at least 2.5 NM out and below the glidepath; an unstable approach goes around. Runways open and close with the wind
      (tailwind over 5 kt or crosswind over 25 kt).</p>
    <h3>Scoring</h3>
    <table>${rows}</table>
    <p class="dim">The score is multiplied by the traffic rate and the extra difficulty (events, live weather, gusts). One loss of separation caps the grade at C, three at E.</p>
    <h3>About</h3>
    <p>flightcATCher by Richard T. (bitdaemon). Web version of the macOS game. Apache 2.0 licence.
      Airport data from FAA CIFP. Weather from the NOAA Aviation Weather Center.</p>`;
  dialog("dlg-help", "Commands and scoring", body);
  void app;
}

// MARK: Debrief

export function openDebrief(app: App, card: ScoreCard): void {
  const sim = app.sim!;
  const icao = app.airport?.icao ?? "----";
  const minutes = Math.round(card.durationSeconds(sim.tickCount) / 60);
  let place: number | null = null;
  if (card.arrivalsHandled + card.departuresHandled > 0) {
    const r: ScoreRecord = {
      date: new Date().toISOString(), total: card.total, grade: card.grade ?? "-", minutes, multiplier: card.multiplier,
      arrivals: card.arrivalsHandled, departures: card.departuresHandled, losses: card.losses, seed: app.trafficSeed.toString(),
    };
    place = addScore(icao, r);
  }
  const best = loadScores(icao);
  const grade = card.grade;
  const cats = SCORE_CATEGORIES.map((c) => {
    const p = card.pointsIn(c);
    return `<tr><td>${CATEGORY_TITLE[c]}</td><td class="num ${p >= 0 ? "pos" : "neg"}">${p}</td></tr>`;
  }).join("");
  const worst = card.worstMoments().map((e) => `<tr><td class="mono">${pad2(Math.trunc(e.tick / 60))}:${pad2(e.tick % 60)}</td><td>${esc(scoreEventText(e))}</td></tr>`).join("");
  const arrivals = card.arrivals.slice(-12).map((a) => `<tr><td>${a.callsign}</td><td class="num">${Math.round(a.actualSeconds / 60)} min</td><td class="num">${Math.round(a.cleanSeconds / 60)} min</td><td class="num">${a.instructions}</td><td class="num pos">+${a.bonus}</td></tr>`).join("");
  const body = `
    <div class="row" style="align-items:flex-end;gap:24px">
      <div><div class="grade">${grade ?? "–"}</div><div class="dim">${grade ? GRADE_RANK[grade] : "no aircraft handled yet"}</div></div>
      <div><div class="big">${card.total}</div><div class="dim">${card.raw} points × ${card.multiplier.toFixed(2)}${place ? ` · #${place} at ${icao}` : ""}</div></div>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="v">${minutes} min</div><div class="l">session</div></div>
      <div class="kpi"><div class="v">${card.arrivalsHandled}</div><div class="l">arrivals to tower</div></div>
      <div class="kpi"><div class="v">${card.departuresHandled}</div><div class="l">departures handed off</div></div>
      <div class="kpi"><div class="v ${card.losses ? "neg" : ""}">${card.losses}</div><div class="l">losses of separation</div></div>
      <div class="kpi"><div class="v">${card.controllerGoArounds}</div><div class="l">go-arounds caused</div></div>
      <div class="kpi"><div class="v">${card.instructionsPerArrival?.toFixed(1) ?? "–"}</div><div class="l">instructions per arrival</div></div>
    </div>
    <h3>Breakdown</h3><table>${cats}</table>
    ${worst ? `<h3>Costly moments</h3><table>${worst}</table>` : ""}
    ${arrivals ? `<h3>Arrivals</h3><table><tr><th>Callsign</th><th class="num">Took</th><th class="num">Clean</th><th class="num">Instr.</th><th class="num">Bonus</th></tr>${arrivals}</table>` : ""}
    ${best.length ? `<h3>Best at ${icao}</h3><table><tr><th>#</th><th>Date</th><th class="num">Score</th><th>Grade</th><th class="num">Min</th><th class="num">Arr/Dep</th></tr>${best.map((b, i) => `<tr><td>${i + 1}</td><td>${new Date(b.date).toLocaleDateString()}</td><td class="num">${b.total}</td><td>${b.grade}</td><td class="num">${b.minutes}</td><td class="num">${b.arrivals}/${b.departures}</td></tr>`).join("")}</table>` : ""}`;
  const footer = `<button class="tb" id="db-replay" title="Same traffic again">Replay seed</button><button class="tb" id="db-new">New session</button><span class="grow"></span><button class="tb primary" id="db-resume">Resume</button>`;
  const d = dialog("dlg-debrief", `Debrief · ${icao}`, body, footer);
  let handled = false;
  const resume = () => { if (!handled) { handled = true; app.resumeSession(); } };
  d.querySelector("#db-resume")!.addEventListener("click", () => { resume(); d.close(); });
  d.querySelector("#db-new")!.addEventListener("click", () => { handled = true; d.close(); app.newSession(); });
  d.querySelector("#db-replay")!.addEventListener("click", () => {
    handled = true;
    app.settings.traffic.fixedSeed = app.trafficSeed.toString();
    d.close();
    app.settingsChanged(false);
    app.newSession();
    app.notice(`Traffic seed fixed (Settings to clear it)`);
  });
  d.addEventListener("close", resume, { once: true });
}

// MARK: Macros

const MACRO_HELP = `codes as on the command bar: d30 h270l s180 p cape i4r j I27.AYBEE ho lu to
one step per line (or ";"); codes on one line go out as one call
triggers:  at CAPE:   when alt<4000:   when spd<=180:   (colon optional; alt<40 = 4000 ft)
run: CALLSIGN mac NAME, stop: CALLSIGN mac-, or MAC in the aircraft's menu
your own instruction cancels it; a refusal stops it (M! on the radio)
a step waiting over 5 minutes for its trigger stops the macro`;

export function openMacros(app: App): void {
  const icao = app.airport?.icao ?? "-";
  const d = dialog("dlg-macros", `Macros · ${icao}`, `<div class="mac-grid"><div><div class="mac-list" id="mac-list"></div>
      <div class="row"><button class="tb" id="mac-new">+ New</button><button class="tb" id="mac-dup">Duplicate</button><button class="tb end" id="mac-del">Delete</button></div>
      <div class="row"><button class="tb" id="mac-examples" title="Adds SLOW, EXIT and GO">Add examples</button></div></div>
    <div class="mac-edit" id="mac-edit"></div></div>
    <div class="mac-help">${esc(MACRO_HELP).replace(/\n/g, "<br>")}</div>`);
  let selection: string | null = app.macros[0]?.id ?? null;
  const list = d.querySelector<HTMLElement>("#mac-list")!;
  const edit = d.querySelector<HTMLElement>("#mac-edit")!;
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
  const uniqueName = (base: string) => {
    let name = base.slice(0, 12), n = 2;
    while (app.macros.some((m) => m.name.toUpperCase() === name.toUpperCase())) name = (base.slice(0, 10) + n++).slice(0, 12);
    return name;
  };

  const renderList = () => {
    list.innerHTML = (["arrival", "departure", "ground"] as MacroPhase[]).map((phase) => {
      const items = app.macros.filter((m) => m.phase === phase).sort((a, b) => a.name.localeCompare(b.name));
      if (!items.length) return "";
      return `<div class="grp">${PHASE_LABEL[phase].toUpperCase()}</div>` + items.map((m) => {
        const bad = "error" in app.compile(m);
        return `<button data-id="${m.id}" class="${m.id === selection ? "cur" : ""}"><span>${esc(m.name || "(unnamed)")}</span>${bad ? '<span class="bad" title="Has an error; will not run">!</span>' : ""}</button>`;
      }).join("");
    }).join("") || `<div class="grp">NO MACROS FOR ${icao}</div><div class="dim" style="padding:4px 10px 10px">+ New adds one. Macros are saved per airport, in this browser.</div>`;
  };

  const renderStatus = (m: Macro) => {
    const st = edit.querySelector<HTMLElement>("#mac-status")!;
    const steps = edit.querySelector<HTMLElement>("#mac-steps")!;
    const dup = app.macros.some((x) => x.id !== m.id && x.name.toUpperCase() === m.name.toUpperCase());
    const c = app.compile(m);
    if ("error" in c) {
      st.innerHTML = `<span class="err">✖ ${esc(macroErrorText(c.error))}</span>`;
      steps.innerHTML = "";
    } else {
      st.innerHTML = `<span class="ok">✔ ${c.ok.steps.length} step${c.ok.steps.length === 1 ? "" : "s"}</span>` +
        (dup ? ` <span class="err">another macro has this name</span>` : "");
      steps.innerHTML = c.ok.steps.map((s, i) =>
        `<div>${i + 1} ${s.trigger ? `<b>${esc(triggerLabel(s.trigger))}</b> ` : ""}› ${esc(s.commands.map(commandCode).join(" "))}</div>`).join("");
    }
    const sel = app.selected ? app.sim?.aircraft.find((a) => a.callsign === app.selected) : undefined;
    const run = edit.querySelector<HTMLButtonElement>("#mac-run")!;
    run.textContent = `Run on ${app.selected ?? "selected"}`;
    run.disabled = !sel || "error" in c || dup || phaseOf(sel) !== m.phase;
    run.title = !sel ? "Select an aircraft first" : phaseOf(sel) !== m.phase ? `${sel.callsign} is not ${m.phase === "arrival" ? "an" : "a"} ${m.phase}` : "";
  };

  const renderEditor = () => {
    const m = app.macros.find((x) => x.id === selection);
    if (!m) {
      edit.innerHTML = `<p class="dim">${app.macros.length ? "Select a macro." : "No macros for this airport yet."}</p>`;
      return;
    }
    edit.innerHTML = `
      <div class="row"><label style="min-width:60px">Name</label><input class="search" id="mac-name" maxlength="12" style="width:170px;font-family:var(--mono)" value="${esc(m.name)}"/>
        <select id="mac-phase" class="search" style="width:auto">${(["arrival", "departure", "ground"] as MacroPhase[]).map((p) => `<option value="${p}" ${m.phase === p ? "selected" : ""}>${PHASE_LABEL[p]}</option>`).join("")}</select></div>
      <textarea id="mac-text" spellcheck="false" autocapitalize="off" autocorrect="off" placeholder="s210&#10;at CAPE: d30, s180&#10;when alt<4000: i4r">${esc(m.text)}</textarea>
      <div class="mac-status" id="mac-status"></div>
      <div class="mac-steps" id="mac-steps"></div>
      <div class="row"><button class="tb primary" id="mac-run">Run</button></div>`;
    const changed = () => {
      m.name = edit.querySelector<HTMLInputElement>("#mac-name")!.value.trim().toUpperCase();
      m.phase = edit.querySelector<HTMLSelectElement>("#mac-phase")!.value as MacroPhase;
      m.text = edit.querySelector<HTMLTextAreaElement>("#mac-text")!.value;
      app.saveMacros();
      renderList();
      renderStatus(m);
    };
    edit.querySelectorAll("input, select, textarea").forEach((el) => el.addEventListener("input", changed));
    edit.querySelector("#mac-phase")!.addEventListener("change", changed);
    edit.querySelector("#mac-run")!.addEventListener("click", () => {
      if (app.selected && app.runMacro(m.name, app.selected) === null) d.close();
    });
    renderStatus(m);
  };

  list.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
    if (!b) return;
    selection = b.dataset.id!;
    renderList();
    renderEditor();
  });
  d.querySelector("#mac-new")!.addEventListener("click", () => {
    const sel = app.selected ? app.sim?.aircraft.find((a) => a.callsign === app.selected) : undefined;
    const m: Macro = { id: newId(), name: uniqueName("NEW"), phase: sel ? phaseOf(sel) : "arrival", text: "" };
    app.macros.push(m);
    selection = m.id;
    app.saveMacros();
    renderList();
    renderEditor();
    edit.querySelector<HTMLInputElement>("#mac-name")?.select();
  });
  d.querySelector("#mac-dup")!.addEventListener("click", () => {
    const src = app.macros.find((x) => x.id === selection);
    if (!src) return;
    const m: Macro = { ...src, id: newId(), name: uniqueName(src.name) };
    app.macros.push(m);
    selection = m.id;
    app.saveMacros();
    renderList();
    renderEditor();
  });
  d.querySelector("#mac-del")!.addEventListener("click", () => {
    const i = app.macros.findIndex((x) => x.id === selection);
    if (i < 0 || !confirm(`Delete macro ${app.macros[i].name}?`)) return;
    app.macros.splice(i, 1);
    selection = app.macros[0]?.id ?? null;
    app.saveMacros();
    renderList();
    renderEditor();
  });
  d.querySelector("#mac-examples")!.addEventListener("click", () => {
    for (const ex of MACRO_EXAMPLES) {
      if (app.macros.some((m) => m.name === ex.name)) continue;
      app.macros.push({ ...ex, id: newId() });
    }
    selection ??= app.macros[0]?.id ?? null;
    app.saveMacros();
    renderList();
    renderEditor();
  });
  renderList();
  renderEditor();
}
