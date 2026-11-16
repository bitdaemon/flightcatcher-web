// Macros: saved, per-airport sequences of instructions with optional triggers. Ported from SimCore/Macro.swift.
//
// Step syntax: `[trigger:] codes`, codes as on the command bar, separated by spaces or commas. One step per line
// (a ";" also ends a step); blank lines and `#` comments are ignored.
//   s210
//   at CAPE: d30, s180
//   when alt<4000: i4r
//   when spd<=180: h270l
// Triggers: `at FIX` (passing the fix), `when alt` or `when spd` with <, <=, > or >=. The colon is optional.
// Altitudes in triggers are feet; a number below 1000 is read as hundreds, like the codes (alt<40 = 4000 ft).
import type { Aircraft } from "./aircraft";
import type { ApproachJoin } from "./airport";
import type { Command } from "./command";
import { parseChain } from "./commandBar";

export type MacroPhase = "arrival" | "departure" | "ground";
export const MACRO_PHASES: MacroPhase[] = ["arrival", "departure", "ground"];
export const PHASE_LABEL: Record<MacroPhase, string> = { arrival: "Arrival", departure: "Departure", ground: "Ground" };

export function phaseOf(ac: Aircraft): MacroPhase {
  if (ac.isOnGround) return "ground";
  return ac.departure === null ? "arrival" : "departure";
}

/** A macro as the player writes it and as it is saved. */
export interface Macro {
  id: string;
  name: string;
  phase: MacroPhase;
  text: string;
}

export type MacroComparison = "<=" | ">=" | "<" | ">";
const COMPARISONS: MacroComparison[] = ["<=", ">=", "<", ">"];

function holds(c: MacroComparison, value: number, limit: number): boolean {
  switch (c) {
    case "<": return value < limit;
    case "<=": return value <= limit;
    case ">": return value > limit;
    case ">=": return value >= limit;
  }
}

export type MacroTrigger =
  | { k: "atFix"; fix: string }
  | { k: "altitude"; cmp: MacroComparison; value: number }
  | { k: "speed"; cmp: MacroComparison; value: number };

/** Short form for the track tag: "@CAPE", "A<4000", "S<=180". */
export function triggerLabel(t: MacroTrigger): string {
  switch (t.k) {
    case "atFix": return "@" + t.fix;
    case "altitude": return `A${t.cmp}${t.value}`;
    case "speed": return `S${t.cmp}${t.value}`;
  }
}

export function triggerHolds(t: MacroTrigger, ac: Aircraft): boolean | null {
  if (t.k === "altitude") return holds(t.cmp, ac.altitudeFt, t.value);
  if (t.k === "speed") return holds(t.cmp, ac.speedKt, t.value);
  return null;
}

export interface MacroStep {
  trigger: MacroTrigger | null;
  /** Sent together as one transmission when the trigger fires. */
  commands: Command[];
}

export interface CompiledMacro {
  name: string;
  phase: MacroPhase;
  steps: MacroStep[];
}

export interface MacroError {
  /** 1-based step number, or 0 for the macro as a whole. */
  step: number;
  message: string;
}

export function macroErrorText(e: MacroError): string {
  return e.step === 0 ? e.message : `step ${e.step}: ${e.message}`;
}

/** Names: letters, digits, - and _, up to 12 characters, so they fit in a track tag and on the command bar. */
export function validMacroName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,12}$/.test(name);
}

export function stepLines(text: string): string[] {
  return text.split(/[\n;]/).map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
}

type TriggerParse = { ok: MacroTrigger } | { error: string };

export function parseTrigger(raw: string, knownFixes: Set<string>): TriggerParse {
  const words = raw.split(/\s+/).filter((w) => w.length > 0);
  const first = words[0]?.toLowerCase();
  if (!first) return { error: "empty trigger before ':'" };
  if (first === "at") {
    if (words.length !== 2) return { error: "write the trigger as: at FIX" };
    const fix = words[1].toUpperCase();
    if (!knownFixes.has(fix)) return { error: `fix ${fix} is not on this airport's map` };
    return { ok: { k: "atFix", fix } };
  }
  if (first === "when") {
    const expression = words.slice(1).join("").toLowerCase();
    for (const [prefix, isAltitude] of [["alt", true], ["spd", false]] as const) {
      if (!expression.startsWith(prefix)) continue;
      const rest = expression.slice(prefix.length);
      const cmp = COMPARISONS.find((c) => rest.startsWith(c));
      if (!cmp) return { error: `use <, <=, > or >= after ${prefix}` };
      const number = rest.slice(cmp.length);
      if (!/^[0-9]+$/.test(number)) return { error: `bad number in '${raw.trim()}'` };
      const value = Number(number);
      if (isAltitude) return { ok: { k: "altitude", cmp, value: value < 1000 ? value * 100 : value } };
      return { ok: { k: "speed", cmp, value } };
    }
    return { error: "after 'when' use alt or spd, for example when alt<4000" };
  }
  return { error: "a trigger starts with 'at' or 'when'" };
}

/** Instructions that can never be accepted by an aircraft of this phase. */
function phaseProblem(c: Command, phase: MacroPhase): string | null {
  const ground = c.k === "lineUp" || c.k === "takeoff";
  if (phase === "ground") return ground ? null : "a ground macro can only use lu and to";
  if (ground) return "lu and to are for ground macros";
  if (phase === "departure" && (c.k === "approach" || c.k === "visualApproach" || c.k === "joinApproach")) {
    return "a departure macro cannot clear an approach";
  }
  return null;
}

export type CompileResult = { ok: CompiledMacro } | { error: MacroError };

export function compileMacro(m: Macro, knownFixes: Set<string>, approaches: Map<string, ApproachJoin> = new Map()): CompileResult {
  if (!validMacroName(m.name)) return { error: { step: 0, message: "name must be 1 to 12 letters, digits, - or _" } };
  const lines = stepLines(m.text);
  if (lines.length === 0) return { error: { step: 0, message: "the macro has no steps" } };
  const steps: MacroStep[] = [];
  for (let index = 0; index < lines.length; index++) {
    const n = index + 1;
    const line = lines[index];
    let trigger: MacroTrigger | null = null;
    let body = line;
    const colon = line.indexOf(":");
    const firstWord = line.split(/\s+/)[0]?.toLowerCase();
    if (colon >= 0) {
      const t = parseTrigger(line.slice(0, colon), knownFixes);
      if ("error" in t) return { error: { step: n, message: t.error } };
      trigger = t.ok;
      body = line.slice(colon + 1);
    } else if (firstWord === "at" || firstWord === "when") {
      // The colon is optional: "at CAPE d30 s180", "when alt<4000 i4r", "when alt < 4000 i4r".
      const words = line.split(/\s+/).filter((w) => w.length > 0);
      let found: [MacroTrigger, number] | null = null;
      let lastError = "write a trigger as: at FIX, or when alt<4000";
      for (let count = Math.min(4, words.length); count >= 2; count--) {
        const t = parseTrigger(words.slice(0, count).join(" "), knownFixes);
        if ("ok" in t) { found = [t.ok, count]; break; }
        lastError = t.error;
      }
      if (!found) return { error: { step: n, message: lastError } };
      trigger = found[0];
      body = words.slice(found[1]).join(" ");
    }
    const parsed = parseChain(body, knownFixes, approaches);
    if ("error" in parsed) return { error: { step: n, message: parsed.error } };
    if (parsed.ok.length === 0) {
      return { error: { step: n, message: trigger === null ? "no instruction" : `add the instruction to send after the trigger, for example: ${line} s180` } };
    }
    for (const c of parsed.ok) {
      const p = phaseProblem(c, m.phase);
      if (p) return { error: { step: n, message: p } };
    }
    steps.push({ trigger, commands: parsed.ok });
  }
  return { ok: { name: m.name.toUpperCase(), phase: m.phase, steps } };
}

/** A macro running on one aircraft. One per aircraft; a new one replaces it. */
export interface MacroRun {
  macro: CompiledMacro;
  /** Index of the next step to send. */
  stepIndex: number;
  /** Tick at which the current step started waiting, for the timeout. */
  stepStartTick: number;
  /** Route fix the aircraft was flying to on the previous tick, to notice it passing an `at FIX` trigger. */
  lastTarget: string | null;
}

export function nextStep(run: MacroRun): MacroStep | null {
  return run.macro.steps[run.stepIndex] ?? null;
}

/** Track tag line: "M APPR 2/4 @CAPE". */
export function runTagText(run: MacroRun): string {
  const total = run.macro.steps.length;
  let text = `M ${run.macro.name} ${Math.min(run.stepIndex + 1, total)}/${total}`;
  const t = nextStep(run)?.trigger;
  if (t) text += " " + triggerLabel(t);
  return text;
}

/** Example macros offered when an airport has none yet. */
export const MACRO_EXAMPLES: Omit<Macro, "id">[] = [
  { name: "SLOW", phase: "arrival", text: "s210\nwhen alt<8000: s180\nwhen alt<5000: s160" },
  { name: "EXIT", phase: "departure", text: "# head for the exit fix once clear of the field\nwhen alt>3000: p exit\nwhen alt>9000: s250" },
  { name: "GO", phase: "ground", text: "lu\nto" },
];
