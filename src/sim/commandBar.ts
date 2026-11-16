// Command-bar logic: parse "[callsign fragment] code+number", resolve the aircraft, validate, preview.
// Ported from SimCore/CommandBar.swift.
import type { Aircraft } from "./aircraft";
import type { ApproachJoin, LocalPoint } from "./airport";
import { commandRefusal, commandSummary, EXIT_FIX_TOKEN, type Command, type IssuedCommand, type TurnDirection } from "./command";

export interface CommandBarResult {
  status: "empty" | "incomplete" | "ready" | "error";
  message: string;
  issuedAll: IssuedCommand[];
  selects?: string;
  /** Set for `mac NAME` (run a macro) and `mac-` (cancel the aircraft's macro). */
  macro?: { k: "run"; callsign: string; name: string } | { k: "cancel"; callsign: string };
}

const CODE_LETTERS = new Set(["d", "c", "h", "s", "i", "p", "x"]);
const WORD_COMMANDS: Record<string, Command> = {
  lu: { k: "lineUp" }, to: { k: "takeoff" }, ho: { k: "handoff" }, m: { k: "maintain" },
  own: { k: "resumeNavigation" }, rn: { k: "resumeNavigation" },
};

const isDigits = (s: string) => s.length > 0 && /^[0-9]+$/.test(s);

export function parseRunway(text: string): string | null {
  let digits = text;
  let suffix = "";
  const last = digits.slice(-1);
  if (last && "lrcLRC".includes(last)) {
    suffix = last.toUpperCase();
    digits = digits.slice(0, -1);
  }
  if (digits.length < 1 || digits.length > 2 || !isDigits(digits)) return null;
  const n = Number(digits);
  if (n < 1 || n > 36) return null;
  return (n < 10 ? "0" : "") + String(n) + suffix;
}

export function isCode(rawToken: string, knownFixes: Set<string> = new Set(), approaches: Map<string, ApproachJoin> = new Map()): boolean {
  const lower = rawToken.toLowerCase();
  if (lower === "mac" || lower === "mac-") return true;
  if (rawToken.length > 1 && lower.startsWith("j")) {
    if (/[0-9]/.test(rawToken[1])) return true;
    return approaches.has(rawToken.slice(1).toUpperCase());
  }
  if (WORD_COMMANDS[lower]) return true;
  let token = rawToken;
  if (token.endsWith("!")) token = token.slice(0, -1);
  const first = token.toLowerCase()[0];
  if (!first || !CODE_LETTERS.has(first)) return false;
  if (first === "x") {
    const fix = token.slice(1).toUpperCase().split("@")[0];
    return knownFixes.has(fix);
  }
  if (first === "p") {
    const fixes = token.slice(1).toUpperCase().split(",").filter((f) => f.length > 0);
    return fixes.length > 0 && fixes.every((f) => knownFixes.has(f));
  }
  if (first === "i") return parseRunway(token.slice(1)) !== null;
  let rest = token.slice(1);
  if (first === "h" && rest.length > 0 && "lrLR".includes(rest.slice(-1))) rest = rest.slice(0, -1);
  return isDigits(rest);
}

/** Aircraft matching a fragment of the callsign or radio name, best match first. */
export function rankedMatches(fragment: string, aircraft: Aircraft[]): Aircraft[] {
  const f = fragment.toLowerCase();
  if (!f) return [];
  const scored: [number, Aircraft][] = [];
  for (const ac of aircraft) {
    const cs = ac.callsign.toLowerCase();
    let rank: number | null = null;
    if (cs.startsWith(f)) rank = 0;
    else if (ac.radioName && (ac.radioName.toLowerCase() + ac.callsignNumber.toLowerCase()).startsWith(f)) rank = 1;
    else if (cs.includes(f)) rank = 2;
    if (rank !== null) scored.push([rank, ac]);
  }
  scored.sort((a, b) => a[0] - b[0] || (a[1].callsign < b[1].callsign ? -1 : a[1].callsign > b[1].callsign ? 1 : 0));
  return scored.map((x) => x[1]);
}

/** Splits a line into tokens, folding "x kerav 50" into "xKERAV@50" and "p kerav pizsa" into "pKERAV,PIZSA". */
export function tokenize(input: string, knownFixes: Set<string>): string[] {
  const tokens: string[] = [];
  const raw = input.split(/\s+/).filter((s) => s.length > 0);
  let index = 0;
  while (index < raw.length) {
    const word = raw[index].toLowerCase();
    let crossFix: string | null = null;
    let after = index + 1;
    if (word === "x" && index + 1 < raw.length && knownFixes.has(raw[index + 1].toUpperCase())) {
      crossFix = raw[index + 1].toUpperCase();
      after = index + 2;
    } else if (word.length > 1 && word.startsWith("x") && knownFixes.has(raw[index].slice(1).toUpperCase())) {
      crossFix = raw[index].slice(1).toUpperCase();
    }
    if (word === "j") {
      tokens.push(index + 1 < raw.length ? "j" + raw[index + 1] : "j");
      index += 2;
      continue;
    }
    if (crossFix) {
      if (after < raw.length && /^-?\d+$/.test(raw[after])) {
        tokens.push(`x${crossFix}@${raw[after]}`);
        index = after + 1;
      } else {
        tokens.push(`x${crossFix}@`);
        index = after;
      }
      continue;
    }
    if (word === "p" && index + 1 < raw.length && raw[index + 1].toUpperCase() === EXIT_FIX_TOKEN) {
      tokens.push("p" + EXIT_FIX_TOKEN.toLowerCase());
      index += 2;
      continue;
    }
    let start = -1;
    if (word === "p" && index + 1 < raw.length && knownFixes.has(raw[index + 1].toUpperCase())) start = index + 1;
    else if (raw[index].length > 1 && word.startsWith("p") && knownFixes.has(raw[index].slice(1).toUpperCase())) start = index;
    if (start >= 0) {
      const fixes = start === index ? [raw[index].slice(1).toUpperCase()] : [raw[start].toUpperCase()];
      let next = start === index ? index + 1 : index + 2;
      while (next < raw.length) {
        const w = raw[next].toUpperCase();
        if (knownFixes.has(w)) { fixes.push(w); next++; }
        else if (w.length > 1 && w.startsWith("P") && knownFixes.has(w.slice(1))) { fixes.push(w.slice(1)); next++; }
        else break;
      }
      tokens.push("p" + fixes.join(","));
      index = next;
    } else {
      tokens.push(raw[index]);
      index++;
    }
  }
  return tokens;
}

export interface RunwayChoice {
  join: ApproachJoin;
  onRoute: boolean;
  distanceNM: number;
}

export function runwayChoices(ac: Aircraft, runway: string, approaches: Map<string, ApproachJoin>,
                              fixPositions: Map<string, LocalPoint>): RunwayChoice[] {
  const ahead = new Set(ac.route.slice(ac.routeIndex).map((p) => p.id));
  const seen = new Set<string>();
  const choices: RunwayChoice[] = [];
  for (const join of approaches.values()) {
    if (join.runway !== runway || seen.has(join.procedure)) continue;
    const p = fixPositions.get(join.via);
    if (!p) continue;
    seen.add(join.procedure);
    choices.push({ join, onRoute: ahead.has(join.via), distanceNM: Math.hypot(p.east - ac.eastNM, p.north - ac.northNM) });
  }
  return choices.sort((a, b) =>
    (a.onRoute ? 0 : 1) - (b.onRoute ? 0 : 1) || a.distanceNM - b.distanceNM ||
    (a.join.procedure < b.join.procedure ? -1 : a.join.procedure > b.join.procedure ? 1 : 0));
}

function choicesText(choices: RunwayChoice[], limit = 4): string {
  return choices.slice(0, limit)
    .map((c, i) => `.${i + 1} ${c.onRoute ? "•" : ""}${c.join.procedure} ${Math.round(c.distanceNM)}`)
    .join(", ");
}

type CodeParse = { ok: Command } | { incomplete: string } | { error: string };

function parseCodeCore(token: string, knownFixes: Set<string>, approaches: Map<string, ApproachJoin>): CodeParse {
  const word = WORD_COMMANDS[token.toLowerCase()];
  if (word) return { ok: word };
  if (token.toLowerCase().startsWith("j")) {
    const id = token.slice(1).toUpperCase();
    if (!id) return { incomplete: "type an approach after j, for example j I27.AYBEE" };
    const join = approaches.get(id);
    if (!join) {
      const some = [...approaches.keys()].sort().slice(0, 6).join(", ");
      return { error: `Unknown approach '${id}'` + (some ? `. Approaches: ${some}` : "") };
    }
    return { ok: { k: "joinApproach", procedure: join.procedure, runway: join.runway, via: join.via } };
  }
  const letter = token.toLowerCase()[0];
  if (!letter || !CODE_LETTERS.has(letter)) return { error: `Unknown code '${token}'. Use d, c, h, s, i, p, x, j, m, lu, to or ho` };
  if (letter === "x") {
    const parts = token.slice(1).toUpperCase().split("@");
    const fix = parts[0] ?? "";
    if (!fix) return { incomplete: "type a fix after x, for example x kerav 50" };
    if (!knownFixes.has(fix)) return { error: `Unknown fix '${fix}'` };
    if (parts.length !== 2 || !parts[1]) return { incomplete: `type a level after ${fix}, for example x ${fix.toLowerCase()} 50` };
    if (!isDigits(parts[1]) || parts[1].length > 3) return { error: `Bad level '${parts[1]}'` };
    return { ok: { k: "cross", fix, altitudeFt: Number(parts[1]) * 100 } };
  }
  if (letter === "p") {
    const fixes = token.slice(1).toUpperCase().split(",").filter((f) => f.length > 0);
    if (fixes.length === 0) return { incomplete: "type a fix after p, for example p kerav pizsa" };
    if (fixes.length === 1 && fixes[0] === EXIT_FIX_TOKEN) return { ok: { k: "direct", fix: EXIT_FIX_TOKEN } };
    const bad = fixes.find((f) => !knownFixes.has(f));
    if (bad) return { error: `Unknown fix '${bad}'` };
    return { ok: fixes.length === 1 ? { k: "direct", fix: fixes[0] } : { k: "route", fixes } };
  }
  if (letter === "i") {
    const runway = parseRunway(token.slice(1));
    if (!runway) return token.length === 1 ? { incomplete: "type a runway after i, for example i28l" } : { error: `Bad runway in '${token}'` };
    return { ok: { k: "approach", runway } };
  }
  let digits = token.slice(1);
  let turn: TurnDirection | null = null;
  if (letter === "h" && digits.length > 1 && "lrLR".includes(digits.slice(-1))) {
    turn = digits.slice(-1).toLowerCase() === "l" ? "left" : "right";
    digits = digits.slice(0, -1);
  }
  if (!digits) return { incomplete: `type a number after ${letter}` };
  if (!isDigits(digits) || digits.length > 3) return { error: `Bad number in '${token}'` };
  const value = Number(digits);
  switch (letter) {
    case "d": return { ok: { k: "descend", feet: value * 100 } };
    case "c": return { ok: { k: "climb", feet: value * 100 } };
    case "h": return { ok: { k: "heading", degrees: value === 0 ? 360 : value, turn } };
    default: return { ok: { k: "speed", knots: value } };
  }
}

function parseCode(token: string, knownFixes: Set<string>, approaches: Map<string, ApproachJoin>): CodeParse {
  if (!token.endsWith("!")) return parseCodeCore(token, knownFixes, approaches);
  const r = parseCodeCore(token.slice(0, -1), knownFixes, approaches);
  if ("ok" in r) {
    const k = r.ok.k;
    if (k === "descend" || k === "climb" || k === "heading" || k === "speed") return { ok: { k: "expedite", inner: r.ok } };
    return { error: "Only heading, altitude and speed can be expedited" };
  }
  return r;
}

/** Parses a chain of codes with no callsign, such as "d30 s180" or "d30, s180" (macro steps). Checks syntax and
 * fixes only; whether an aircraft can accept the commands is decided when they are sent. */
export function parseChain(text: string, knownFixes: Set<string>, approaches: Map<string, ApproachJoin> = new Map()):
  { ok: Command[] } | { error: string } {
  const tokens = tokenize(text.replace(/,/g, " "), knownFixes);
  const commands: Command[] = [];
  for (const token of tokens) {
    if (["mac", "mac-"].includes(token.toLowerCase())) return { error: "a macro cannot start another macro" };
    const r = parseCode(token, knownFixes, approaches);
    if ("ok" in r) commands.push(r.ok);
    else if ("incomplete" in r) return { error: r.incomplete };
    else return { error: r.error };
  }
  return { ok: commands };
}

export interface EvaluateContext {
  aircraft: Aircraft[];
  selected: string | null;
  knownFixes: Set<string>;
  approaches: Map<string, ApproachJoin>;
  fixPositions: Map<string, LocalPoint>;
  openRunways: Set<string> | null;
}

export function evaluate(input: string, ctx: EvaluateContext): CommandBarResult {
  const { aircraft, selected, knownFixes, approaches, fixPositions, openRunways } = ctx;
  const tokens = tokenize(input, knownFixes);
  if (tokens.length === 0) return { status: "empty", message: "", issuedAll: [] };

  const fragment = isCode(tokens[0], knownFixes, approaches) ? null : tokens[0];
  const codeTokens = fragment === null ? tokens : tokens.slice(1);

  let target: Aircraft;
  if (fragment !== null) {
    const matches = rankedMatches(fragment, aircraft);
    if (matches.length === 0) return { status: "error", message: `No aircraft matches '${fragment}'`, issuedAll: [] };
    const exact = matches.find((m) => m.callsign.toLowerCase() === fragment.toLowerCase());
    if (exact) target = exact;
    else if (matches.length > 1) {
      return { status: "incomplete", message: `Ambiguous: ${matches.slice(0, 6).map((m) => m.callsign).join(", ")}. Tab to complete`, issuedAll: [] };
    } else target = matches[0];
  } else {
    const ac = selected ? aircraft.find((a) => a.callsign === selected) : undefined;
    if (!ac) return { status: "error", message: "No aircraft selected. Type a callsign first", issuedAll: [] };
    target = ac;
  }

  if (codeTokens.length === 0) {
    return { status: "incomplete", message: `${target.callsign}: Enter to select, or add d, c, h or s with a number`, issuedAll: [], selects: target.callsign };
  }

  let runwayHint = "";
  const joinTable = new Map(approaches);
  const runways = new Set([...approaches.values()].map((j) => j.runway));
  for (const runway of runways) {
    if (openRunways && !openRunways.has(runway)) continue;
    const choices = runwayChoices(target, runway, approaches, fixPositions);
    if (choices.length === 0) continue;
    joinTable.set(runway, choices[0].join);
    choices.slice(0, 9).forEach((c, i) => joinTable.set(`${runway}.${i + 1}`, c.join));
  }
  const jTok = [...codeTokens].reverse().find((t) => t.toLowerCase().startsWith("j") && /[0-9]/.test(t[1] ?? ""));
  if (jTok) {
    const alias = jTok.slice(1);
    const runway = parseRunway(alias.split(".")[0] ?? alias);
    if (runway) {
      const choices = runwayChoices(target, runway, approaches, fixPositions);
      if (openRunways && !openRunways.has(runway)) runwayHint = `  [runway ${runway} is not in use]`;
      else if (choices.length === 0) runwayHint = `  [no approaches to join for ${runway}; use i${runway.toLowerCase()}]`;
      else runwayHint = `  [${runway}: ${choicesText(choices)}]`;
    }
  }

  if (codeTokens[0].toLowerCase() === "mac-") {
    return { status: "ready", message: `${target.callsign}: cancel macro. Enter to send`, issuedAll: [], macro: { k: "cancel", callsign: target.callsign } };
  }
  if (codeTokens[0].toLowerCase() === "mac") {
    if (codeTokens.length < 2) return { status: "incomplete", message: `${target.callsign}: type a macro name after mac`, issuedAll: [] };
    if (codeTokens.length > 2) return { status: "error", message: "mac takes one macro name and nothing after it", issuedAll: [] };
    const name = codeTokens[1].toUpperCase();
    return { status: "ready", message: `${target.callsign}: run macro ${name}. Enter to send`, issuedAll: [], macro: { k: "run", callsign: target.callsign, name } };
  }

  const commands: Command[] = [];
  for (const token of codeTokens) {
    const r = parseCode(token, knownFixes, joinTable);
    if ("ok" in r) {
      const reason = commandRefusal(r.ok, target);
      if (reason) return { status: "error", message: `${target.callsign}: unable, ${reason}`, issuedAll: [] };
      commands.push(r.ok);
    } else if ("incomplete" in r) {
      return { status: "incomplete", message: `${target.callsign}: ${r.incomplete}` + runwayHint, issuedAll: [] };
    } else {
      return { status: "error", message: r.error + runwayHint, issuedAll: [] };
    }
  }
  const all = commands.map((command) => ({ callsign: target.callsign, command }));
  return {
    status: "ready",
    message: `${target.callsign}: ${commands.map(commandSummary).join(", then ")}. Enter to send` + runwayHint,
    issuedAll: all,
  };
}

export interface TabState {
  matches: string[];
  index: number;
  suffix: string;
  lastOutput: string | null;
}
export const newTabState = (): TabState => ({ matches: [], index: 0, suffix: "", lastOutput: null });

export function tabComplete(input: string, aircraft: Aircraft[], state: TabState): string | null {
  if (state.lastOutput !== null && state.lastOutput === input && state.matches.length > 0) {
    state.index = (state.index + 1) % state.matches.length;
    const out = state.matches[state.index] + state.suffix;
    state.lastOutput = out;
    return out;
  }
  const trimmed = input.replace(/^\s+/, "");
  if (!trimmed) return null;
  const m = /^(\S+)(.*)$/s.exec(trimmed)!;
  const first = m[1];
  const rest = m[2];
  if (rest.trim() === "" && isCode(first)) return null;
  const matches = rankedMatches(first, aircraft).map((a) => a.callsign);
  if (matches.length === 0) return null;
  state.matches = matches;
  state.index = 0;
  state.suffix = rest === "" ? " " : rest;
  const out = matches[0] + state.suffix;
  state.lastOutput = out;
  return out;
}
