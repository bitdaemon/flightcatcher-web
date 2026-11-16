// Settings saved in localStorage. Every read tolerates missing or old values.
import { EVENTS_GAME_DEFAULT, type EventSettings } from "../sim/navigation";
import { defaultTraffic, type TrafficSettings } from "../sim/traffic";
import type { WeatherMode } from "../sim/weather";
import type { Macro } from "../sim/macro";
import { DEFAULT_SCHEME } from "../ui/theme";

export interface Layers {
  star: boolean;
  sid: boolean;
  app: boolean;
  fix: boolean;
  rings: boolean;
  compass: boolean;
}

export interface Settings {
  airport: string;
  scheme: string;
  traffic: TrafficSettings;
  events: EventSettings;
  weatherMode: WeatherMode;
  areaRadiusNM: number;
  areaCeilingFt: number;
  layers: Layers;
  panels: { strips: boolean; radio: boolean; info: boolean; runways: boolean };
  numberStyle: "plain" | "icao";
  speech: boolean;
  uiScale: number;
}

const KEY = "flightcatcher.settings.v1";

export function defaultSettings(): Settings {
  const narrow = typeof window !== "undefined" && window.innerWidth < 760;
  return {
    airport: "KATL",
    scheme: DEFAULT_SCHEME,
    traffic: defaultTraffic(),
    events: { ...EVENTS_GAME_DEFAULT },
    weatherMode: "random",
    areaRadiusNM: 40,
    areaCeilingFt: 15000,
    layers: { star: true, sid: false, app: true, fix: true, rings: true, compass: false },
    panels: { strips: !narrow, radio: !narrow, info: !narrow, runways: false },
    numberStyle: "plain",
    speech: false,
    uiScale: 1,
  };
}

export function loadSettings(): Settings {
  const d = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw) as Partial<Settings>;
    return {
      ...d,
      ...s,
      traffic: { ...d.traffic, ...(s.traffic ?? {}) },
      events: { ...d.events, ...(s.events ?? {}) },
      layers: { ...d.layers, ...(s.layers ?? {}) },
      panels: { ...d.panels, ...(s.panels ?? {}) },
    };
  } catch {
    return d;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch { /* private mode */ }
}

export interface ScoreRecord {
  date: string;
  total: number;
  grade: string;
  minutes: number;
  multiplier: number;
  arrivals: number;
  departures: number;
  losses: number;
  seed: string;
}

const SCORES = "flightcatcher.scores.v1";

export function loadScores(icao: string): ScoreRecord[] {
  try {
    const all = JSON.parse(localStorage.getItem(SCORES) ?? "{}") as Record<string, ScoreRecord[]>;
    return all[icao] ?? [];
  } catch {
    return [];
  }
}

/** Adds a session to the airport's best-scores table (top 10). Returns its place, 1-based, or null. */
export function addScore(icao: string, r: ScoreRecord): number | null {
  try {
    const all = JSON.parse(localStorage.getItem(SCORES) ?? "{}") as Record<string, ScoreRecord[]>;
    const list = [...(all[icao] ?? []), r].sort((a, b) => b.total - a.total).slice(0, 10);
    all[icao] = list;
    localStorage.setItem(SCORES, JSON.stringify(all));
    const i = list.indexOf(r);
    return i >= 0 ? i + 1 : null;
  } catch {
    return null;
  }
}

// MARK: Macros, saved per airport

const MACROS = "flightcatcher.macros.v1";

export function loadMacros(icao: string): Macro[] {
  try {
    const all = JSON.parse(localStorage.getItem(MACROS) ?? "{}") as Record<string, Macro[]>;
    return (all[icao.toUpperCase()] ?? []).filter((m) => m && typeof m.name === "string" && typeof m.text === "string");
  } catch {
    return [];
  }
}

export function saveMacros(icao: string, macros: Macro[]): void {
  try {
    const all = JSON.parse(localStorage.getItem(MACROS) ?? "{}") as Record<string, Macro[]>;
    if (macros.length) all[icao.toUpperCase()] = macros;
    else delete all[icao.toUpperCase()];
    localStorage.setItem(MACROS, JSON.stringify(all));
  } catch { /* private mode or storage full */ }
}
