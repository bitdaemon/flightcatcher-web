// The radar scope: a canvas drawn every animation frame from the simulation state, plus pan, zoom, selection,
// tag dragging and the pick modes used by the radial menu (heading by pointing, direct by clicking a fix).
import type { Aircraft } from "../sim/aircraft";
import { LocalProjection, referenceProjection, type AirportPackage } from "../sim/airport";
import { urgencyWord, type RoutePoint } from "../sim/navigation";
import type { Simulation } from "../sim/simulation";
import { bearingDeg, normalized, pad3, round } from "../sim/util";
import { alpha, type SchemeColors } from "./theme";
import type { Layers } from "../data/settings";

export type PickMode =
  | { kind: "none" }
  | { kind: "heading"; callsign: string }
  | { kind: "direct"; callsign: string };

export interface ScopeCallbacks {
  select(callsign: string | null): void;
  radial(callsign: string, x: number, y: number): void;
  heading(callsign: string, degrees: number, invertTurn: boolean): void;
  direct(callsign: string, fix: string): void;
  cancelMode(): void;
}

interface Pt { x: number; y: number }
interface TagBox { callsign: string; x: number; y: number; w: number; h: number }

const EMERGENCY_RED = "#FF3B30";
const FONT = '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace';
const TAG_LINE = 13;
const CHAR_W = 6.9;

export class Scope {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0;
  private h = 0;
  pan: Pt = { x: 0, y: 0 };
  pxPerNM = 8;
  mode: PickMode = { kind: "none" };
  /** Fixes picked so far in direct mode, drawn as the route being built. */
  pendingRoute: string[] = [];
  private hover: Pt | null = null;
  private tagOffsets = new Map<string, Pt>();
  private pinnedTags = new Set<string>();
  private tagBoxes: TagBox[] = [];
  private lastLayout = 0;
  private trails = new Map<string, Pt[]>();
  private lastTrailTick = -1;
  private pointers = new Map<number, Pt>();
  private drag: { kind: "pan" | "tag" | "pinch"; start: Pt; origin: Pt; callsign?: string; dist?: number; scale?: number; moved: boolean } | null = null;
  private longPress: number | null = null;
  private fixScreen = new Map<string, Pt>();

  constructor(private canvas: HTMLCanvasElement, private cb: ScopeCallbacks) {
    this.ctx = canvas.getContext("2d")!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.bindInput();
  }

  private resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
  }

  /** Zoom so the approach area fills the scope. */
  fit(areaRadiusNM: number, insets: { left: number; right: number } = { left: 0, right: 0 }): void {
    const r = this.canvas.getBoundingClientRect();
    const size = Math.min(r.width - insets.left - insets.right, r.height) || 600;
    this.pxPerNM = Math.max(3, (size / 2 - 12) / (areaRadiusNM + 2));
    this.pan = { x: (insets.left - insets.right) / 2, y: 0 };
    this.tagOffsets.clear();
    this.pinnedTags.clear();
    this.trails.clear();
  }

  zoom(factor: number, at?: Pt): void {
    const old = this.pxPerNM;
    const next = Math.min(Math.max(old * factor, 2), 400);
    const c = at ?? { x: this.w / 2, y: this.h / 2 };
    // Keep the point under the cursor still.
    const cx = this.w / 2 + this.pan.x, cy = this.h / 2 + this.pan.y;
    const k = next / old;
    this.pan.x += (c.x - cx) * (1 - k);
    this.pan.y += (c.y - cy) * (1 - k);
    this.pxPerNM = next;
  }

  centreOn(east: number, north: number): void {
    this.pan = { x: -east * this.pxPerNM, y: north * this.pxPerNM };
  }

  private toScreen(east: number, north: number): Pt {
    return { x: this.w / 2 + this.pan.x + east * this.pxPerNM, y: this.h / 2 + this.pan.y - north * this.pxPerNM };
  }

  private toLocal(p: Pt): { east: number; north: number } {
    return { east: (p.x - this.w / 2 - this.pan.x) / this.pxPerNM, north: -(p.y - this.h / 2 - this.pan.y) / this.pxPerNM };
  }

  // MARK: Input

  private state: { sim: Simulation | null; selected: string | null } = { sim: null, selected: null };

  private aircraftAt(p: Pt): string | null {
    const sim = this.state.sim;
    if (!sim) return null;
    for (let i = this.tagBoxes.length - 1; i >= 0; i--) {
      const b = this.tagBoxes[i];
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return b.callsign;
    }
    let best: string | null = null;
    let bestD = 16;
    for (const ac of sim.aircraft) {
      const q = this.toScreen(ac.eastNM, ac.northNM);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bestD) { bestD = d; best = ac.callsign; }
    }
    return best;
  }

  private tagAt(p: Pt): string | null {
    for (let i = this.tagBoxes.length - 1; i >= 0; i--) {
      const b = this.tagBoxes[i];
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return b.callsign;
    }
    return null;
  }

  nearestFix(p: Pt, maxPx = 40): string | null {
    let best: string | null = null;
    let bestD = maxPx;
    for (const [id, q] of this.fixScreen) {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }

  private local(e: PointerEvent | WheelEvent | MouseEvent): Pt {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const p = this.local(e);
      const hit = this.aircraftAt(p);
      if (hit) this.cb.radial(hit, p.x, p.y);
    });
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      this.zoom(factor, this.local(e));
    }, { passive: false });
    c.addEventListener("pointermove", (e) => {
      const p = this.local(e);
      this.hover = p;
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, p);
      const d = this.drag;
      if (!d) return;
      if (d.kind === "pinch" && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const target = d.scale! * (dist / d.dist!);
        this.zoom(target / this.pxPerNM, mid);
        return;
      }
      const dx = p.x - d.start.x, dy = p.y - d.start.y;
      if (!d.moved && Math.hypot(dx, dy) > 6) {
        d.moved = true;
        this.cancelLongPress();
      }
      if (!d.moved) return;
      if (d.kind === "pan") this.pan = { x: d.origin.x + dx, y: d.origin.y + dy };
      else if (d.kind === "tag" && d.callsign) {
        this.tagOffsets.set(d.callsign, { x: d.origin.x + dx, y: d.origin.y + dy });
        this.pinnedTags.add(d.callsign);
      }
    });
    c.addEventListener("pointerdown", (e) => {
      if (e.button === 2) return;
      c.setPointerCapture(e.pointerId);
      const p = this.local(e);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.cancelLongPress();
        this.drag = { kind: "pinch", start: p, origin: p, dist: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), scale: this.pxPerNM, moved: true };
        return;
      }
      const tag = this.mode.kind === "none" ? this.tagAt(p) : null;
      if (tag) {
        const off = this.tagOffsets.get(tag) ?? { x: 10, y: -18 };
        this.drag = { kind: "tag", start: p, origin: { ...off }, callsign: tag, moved: false };
      } else {
        this.drag = { kind: "pan", start: p, origin: { ...this.pan }, moved: false };
      }
      // Long press on an aircraft opens the radial menu (touch screens have no right click).
      if (e.pointerType !== "mouse") {
        const hit = this.aircraftAt(p);
        if (hit) {
          this.longPress = window.setTimeout(() => {
            this.longPress = null;
            if (this.drag) this.drag.moved = true;
            this.cb.radial(hit, p.x, p.y);
          }, 450);
        }
      }
    });
    const up = (e: PointerEvent) => {
      const had = this.pointers.delete(e.pointerId);
      this.cancelLongPress();
      const d = this.drag;
      if (this.pointers.size === 0) this.drag = null;
      if (!had || !d || d.moved || d.kind === "pinch") return;
      if (e.type === "pointercancel") return;
      this.click(this.local(e), e.altKey);
    };
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    c.addEventListener("pointerleave", () => { this.hover = null; });
    c.addEventListener("dblclick", (e) => {
      const p = this.local(e);
      if (this.aircraftAt(p) || this.mode.kind !== "none") return;
      this.zoom(1.6, p);
    });
  }

  private cancelLongPress(): void {
    if (this.longPress !== null) {
      clearTimeout(this.longPress);
      this.longPress = null;
    }
  }

  private click(p: Pt, alt: boolean): void {
    const sim = this.state.sim;
    if (!sim) return;
    const m = this.mode;
    if (m.kind === "heading") {
      const ac = sim.aircraft.find((a) => a.callsign === m.callsign);
      if (ac) {
        const q = this.toScreen(ac.eastNM, ac.northNM);
        const deg = snappedHeading(bearingDeg(p.x - q.x, q.y - p.y));
        this.cb.heading(m.callsign, deg, alt);
      } else this.cb.cancelMode();
      return;
    }
    if (m.kind === "direct") {
      const fix = this.nearestFix(p);
      if (fix) this.cb.direct(m.callsign, fix);
      else this.cb.cancelMode();
      return;
    }
    this.cb.select(this.aircraftAt(p));
  }

  // MARK: Drawing

  draw(sim: Simulation | null, airport: AirportPackage | null, selected: string | null, colors: SchemeColors,
       layers: Layers, available: Set<string>, commandTags: Map<string, string>, macroTags: Map<string, string> = new Map()): void {
    this.state = { sim, selected };
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, this.w, this.h);
    if (!sim || !airport) return;

    if (layers.compass) this.drawCompass(colors);
    const proj = referenceProjection(airport);
    const scale = this.pxPerNM;
    const origin = this.toScreen(0, 0);

    // Range rings and the approach area.
    if (layers.rings) {
      ctx.lineWidth = 1;
      ctx.font = `10px ${FONT}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (let nm = 5; nm <= Math.max(40, sim.areaRadiusNM); nm += 5) {
        const r = nm * scale;
        ctx.strokeStyle = colors.rings;
        ctx.beginPath();
        ctx.arc(origin.x, origin.y, r, 0, Math.PI * 2);
        ctx.stroke();
        if (nm % 10 === 0) {
          ctx.fillStyle = colors.dimText;
          ctx.fillText(String(nm), origin.x + r + 4, origin.y);
        }
      }
    }
    {
      const r = sim.areaRadiusNM * scale;
      ctx.strokeStyle = alpha(colors.heading, 0.45);
      ctx.lineWidth = 1.2;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.arc(origin.x, origin.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = alpha(colors.heading, 0.7);
      ctx.font = `9px ${FONT}`;
      ctx.textAlign = "center";
      ctx.fillText(`APP ${Math.trunc(sim.areaRadiusNM)} NM`, origin.x, origin.y - r - 8);
    }

    // Procedures and fixes.
    this.fixScreen.clear();
    for (const fix of airport.fixes) {
      const q = proj.nm(fix.lat, fix.lon);
      this.fixScreen.set(fix.id, this.toScreen(q.east, q.north));
    }
    const onProc = new Set<string>();
    ctx.lineWidth = 1.5;
    for (const p of airport.procedures) {
      if (!available.has(p.id)) continue;
      let color: string;
      if (p.kind === "star") { if (!layers.star) continue; color = alpha(colors.star, 0.75); }
      else if (p.kind === "sid") { if (!layers.sid) continue; color = alpha(colors.sid, 0.75); }
      else { if (!layers.app) continue; color = alpha(colors.approach, 0.75); }
      ctx.strokeStyle = color;
      ctx.beginPath();
      let started = false;
      for (const leg of p.legs) {
        const q = this.fixScreen.get(leg.fixId);
        if (!q) continue;
        if (started) ctx.lineTo(q.x, q.y); else { ctx.moveTo(q.x, q.y); started = true; }
        onProc.add(leg.fixId);
      }
      ctx.stroke();
    }
    const directMode = this.mode.kind === "direct";
    const hoverFix = directMode && this.hover ? this.nearestFix(this.hover) : null;
    if (layers.fix || directMode) {
      ctx.font = `9px ${FONT}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      for (const [id, q] of this.fixScreen) {
        if (q.x < -50 || q.y < -50 || q.x > this.w + 50 || q.y > this.h + 50) continue;
        const on = onProc.has(id);
        const isHover = id === hoverFix;
        const col = isHover ? colors.selected : on ? colors.fix : alpha(colors.fix, 0.55);
        ctx.strokeStyle = col;
        ctx.lineWidth = isHover ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(q.x, q.y - 4);
        ctx.lineTo(q.x + 3.5, q.y + 3);
        ctx.lineTo(q.x - 3.5, q.y + 3);
        ctx.closePath();
        ctx.stroke();
        if ((on && scale >= 6) || scale >= 14 || isHover || (directMode && scale >= 5)) {
          ctx.fillStyle = col;
          ctx.font = isHover ? `bold 11px ${FONT}` : `9px ${FONT}`;
          ctx.fillText(id, q.x + 6, q.y - 4);
        }
      }
    }

    // Runways: open ones bright with a 10 NM extended centreline, closed ones dimmed and crossed out.
    const open = sim.openRunways;
    const runways = [...airport.runways].sort((a, b) => Number(open.has(a.id)) - Number(open.has(b.id)));
    for (const rwy of runways) {
      const isOpen = open.has(rwy.id);
      const t = proj.nm(rwy.thresholdLat, rwy.thresholdLon);
      const disp = (rwy.lengthM - rwy.ldaM) / 1852;
      const len = rwy.lengthM / 1852;
      const back = LocalProjection.offset(rwy.trueBearingDeg + 180, disp);
      const along = LocalProjection.offset(rwy.trueBearingDeg, len);
      const s = { east: t.east + back.east, north: t.north + back.north };
      const e = { east: s.east + along.east, north: s.north + along.north };
      const a = this.toScreen(s.east, s.north), b = this.toScreen(e.east, e.north);
      ctx.strokeStyle = isOpen ? colors.runway : alpha(colors.dimText, 0.55);
      ctx.lineWidth = isOpen ? Math.max(3, Math.min(6, scale * 0.03)) : 2;
      ctx.lineCap = "butt";
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const tp = this.toScreen(t.east, t.north);
      if (isOpen) {
        const out = LocalProjection.offset(rwy.trueBearingDeg + 180, 10);
        const o = this.toScreen(t.east + out.east, t.north + out.north);
        ctx.strokeStyle = colors.runwayCentreline;
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 6]);
        ctx.beginPath(); ctx.moveTo(tp.x, tp.y); ctx.lineTo(o.x, o.y); ctx.stroke();
        ctx.setLineDash([]);
        // Marks every 5 NM on the final.
        for (const nm of [5, 10]) {
          const m = LocalProjection.offset(rwy.trueBearingDeg + 180, nm);
          const n = LocalProjection.offset(rwy.trueBearingDeg + 90, 0.6);
          const c1 = this.toScreen(t.east + m.east + n.east, t.north + m.north + n.north);
          const c2 = this.toScreen(t.east + m.east - n.east, t.north + m.north - n.north);
          ctx.beginPath(); ctx.moveTo(c1.x, c1.y); ctx.lineTo(c2.x, c2.y); ctx.stroke();
        }
      } else {
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        ctx.strokeStyle = colors.warning;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(mid.x - 4, mid.y - 4); ctx.lineTo(mid.x + 4, mid.y + 4);
        ctx.moveTo(mid.x - 4, mid.y + 4); ctx.lineTo(mid.x + 4, mid.y - 4);
        ctx.stroke();
      }
      ctx.fillStyle = isOpen ? colors.runway : alpha(colors.dimText, 0.55);
      ctx.beginPath(); ctx.arc(tp.x, tp.y, 2.5, 0, Math.PI * 2); ctx.fill();
      if (scale >= 5 || isOpen) {
        ctx.font = `${isOpen ? "bold " : ""}10px ${FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const lab = LocalProjection.offset(rwy.trueBearingDeg + 180, Math.max(0.35, 14 / scale));
        const lp = this.toScreen(t.east + back.east + lab.east, t.north + back.north + lab.north);
        ctx.fillStyle = isOpen ? colors.runway : alpha(colors.dimText, 0.7);
        ctx.fillText(rwy.id, lp.x, lp.y);
      }
    }

    // Conflict lines.
    const worst = new Map<string, "predicted" | "loss">();
    for (const c of sim.conflicts) {
      const a = sim.aircraft.find((x) => x.callsign === c.first);
      const b = sim.aircraft.find((x) => x.callsign === c.second);
      if (!a || !b) continue;
      const col = c.kind === "loss" ? colors.alert : colors.warning;
      const pa = this.toScreen(a.eastNM, a.northNM), pb = this.toScreen(b.eastNM, b.northNM);
      ctx.strokeStyle = alpha(col, 0.9);
      ctx.lineWidth = 1.5;
      ctx.setLineDash(c.kind === "loss" ? [] : [5, 4]);
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      ctx.setLineDash([]);
      for (const id of [c.first, c.second]) if (!worst.has(id) || c.kind === "loss") worst.set(id, c.kind);
    }

    // History trails, sampled every 4 simulated seconds.
    if (sim.tickCount !== this.lastTrailTick && sim.tickCount % 4 === 0) {
      this.lastTrailTick = sim.tickCount;
      const present = new Set<string>();
      for (const ac of sim.aircraft) {
        present.add(ac.callsign);
        if (ac.isOnGround) continue;
        const list = this.trails.get(ac.callsign) ?? [];
        list.push({ x: ac.eastNM, y: ac.northNM });
        if (list.length > 6) list.shift();
        this.trails.set(ac.callsign, list);
      }
      for (const k of [...this.trails.keys()]) if (!present.has(k)) this.trails.delete(k);
    }

    // Selected aircraft: remaining route, exit fix, level-off point.
    const sel = selected ? sim.aircraft.find((a) => a.callsign === selected) : undefined;
    if (sel) this.drawSelectedOverlay(sel, sim, airport, colors);

    // Pick mode overlays.
    if (this.mode.kind === "heading" && this.hover) {
      const m = this.mode;
      const ac = sim.aircraft.find((a) => a.callsign === m.callsign);
      if (ac) {
        const q = this.toScreen(ac.eastNM, ac.northNM);
        const deg = snappedHeading(bearingDeg(this.hover.x - q.x, q.y - this.hover.y));
        const rad = (deg * Math.PI) / 180;
        const len = Math.max(60, Math.hypot(this.hover.x - q.x, this.hover.y - q.y));
        ctx.strokeStyle = colors.selected;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([8, 5]);
        ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x + Math.sin(rad) * len, q.y - Math.cos(rad) * len); ctx.stroke();
        ctx.setLineDash([]);
        const turn = signedTurnLabel(ac.headingDeg, deg);
        ctx.font = `bold 12px ${FONT}`;
        ctx.fillStyle = colors.selected;
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(`HDG ${pad3(deg)} ${turn}`, this.hover.x + 12, this.hover.y - 6);
      }
    }

    if (this.mode.kind === "direct" && this.pendingRoute.length) {
      const m = this.mode;
      const ac = sim.aircraft.find((a) => a.callsign === m.callsign);
      const pts = this.pendingRoute.map((id) => ({ id, q: this.fixScreen.get(id) })).filter((x): x is { id: string; q: Pt } => !!x.q);
      if (ac && pts.length) {
        const a0 = this.toScreen(ac.eastNM, ac.northNM);
        ctx.strokeStyle = colors.selected;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([8, 5]);
        ctx.beginPath();
        ctx.moveTo(a0.x, a0.y);
        for (const x of pts) ctx.lineTo(x.q.x, x.q.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = `bold 11px ${FONT}`;
        ctx.fillStyle = colors.selected;
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        pts.forEach((x, i) => {
          ctx.beginPath(); ctx.arc(x.q.x, x.q.y, 6, 0, Math.PI * 2); ctx.stroke();
          ctx.fillText(`${i + 1} ${x.id}`, x.q.x + 9, x.q.y - 6);
        });
      }
    }

    // Aircraft.
    const boxes: TagBox[] = [];
    const tagged: { ac: Aircraft; p: Pt; lines: string[]; col: string; box: string; marker: boolean }[] = [];
    for (const ac of sim.aircraft) {
      const handed = ac.handedToTower;
      let col = ac.callsign === selected ? colors.selected : colors.aircraft;
      if (handed) col = alpha(colors.dimText, 0.75);
      const w = worst.get(ac.callsign);
      if (w) col = w === "loss" ? colors.alert : colors.warning;
      const p = this.toScreen(ac.eastNM, ac.northNM);

      const trail = this.trails.get(ac.callsign);
      if (trail) {
        ctx.fillStyle = alpha(handed ? colors.dimText : colors.heading, 0.5);
        trail.forEach((t, i) => {
          const q = this.toScreen(t.x, t.y);
          const r = 0.8 + (i / trail.length) * 1.2;
          ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.fill();
        });
      }
      if (w) {
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.stroke();
      }
      if (ac.emergency && !handed) {
        ctx.strokeStyle = EMERGENCY_RED;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, 12, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = alpha(EMERGENCY_RED, 0.55);
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.arc(p.x, p.y, 17, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
      if (!handed && !ac.isOnGround) {
        const ahead = LocalProjection.offset(ac.headingDeg, ac.speedKt / 60);
        const v = this.toScreen(ac.eastNM + ahead.east, ac.northNM + ahead.north);
        ctx.strokeStyle = alpha(col, 0.7);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(v.x, v.y); ctx.stroke();
      }
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      if (ac.isOnGround) {
        ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.stroke();
      } else {
        ctx.strokeRect(p.x - 4, p.y - 4, 8, 8);
      }
      if (ac.groundPhase === "holdingShort" || ac.groundPhase === "linedUp") continue;
      tagged.push({ ac, p, lines: this.tagLines(ac, commandTags.get(ac.callsign), macroTags.get(ac.callsign)), col, box: ac.emergency && !handed ? EMERGENCY_RED : col, marker: false });
    }

    // Tag layout: keep each tag where it is if that spot is clear, else try nearby spots.
    const now = performance.now();
    const relayout = now - this.lastLayout > 700;
    if (relayout) this.lastLayout = now;
    const placed: TagBox[] = [];
    const symbols = tagged.map((t) => t.p);
    for (const t of tagged) {
      const size = { w: Math.max(...t.lines.map((l) => l.length)) * CHAR_W + 10, h: t.lines.length * TAG_LINE + 6 };
      let off = this.tagOffsets.get(t.ac.callsign) ?? { x: 10, y: -size.h - 2 };
      if (relayout && !this.pinnedTags.has(t.ac.callsign)) {
        const cost = (o: Pt) => overlapCost({ callsign: "", x: t.p.x + o.x, y: t.p.y + o.y, w: size.w, h: size.h }, placed, symbols, t.p);
        if (cost(off) > 0) {
          let best = off, bestCost = cost(off);
          for (const c of tagCandidates(size.w, size.h)) {
            const k = cost(c);
            if (k < bestCost) { best = c; bestCost = k; if (k === 0) break; }
          }
          off = best;
        }
        this.tagOffsets.set(t.ac.callsign, off);
      }
      const box = { callsign: t.ac.callsign, x: t.p.x + off.x, y: t.p.y + off.y, w: size.w, h: size.h };
      placed.push(box);
      this.drawTag(t.ac, t.p, box, t.lines, t.col, t.box, selected, colors);
      boxes.push(box);
    }
    this.tagBoxes = boxes;
  }

  private tagLines(ac: Aircraft, command: string | undefined, macro?: string): string[] {
    if (ac.handedToTower) return [ac.callsign];
    const top = ac.callsign + (ac.typeCode ? " " + ac.typeCode : "");
    let bottom = ac.labelBottom;
    if (!ac.groundPhase) {
      const tgt = round(ac.targetAltitudeFt / 100);
      const cur = round(ac.altitudeFt / 100);
      if (tgt !== cur && !(ac.approach?.phase === "glideslope")) bottom += (tgt > cur ? "↑" : "↓") + pad3(tgt);
    }
    const lines = [top, bottom];
    if (ac.emergency) lines.splice(1, 0, urgencyWord(ac.emergency));
    const d = ac.departure;
    if (d && !d.handedOff) {
      const exit = d.exitFix ? ` → ${d.exitFix}` : "";
      if (ac.onRunwayHeading) lines.push("RWY HDG" + exit);
      else if (exit) lines.push("EXIT" + exit);
    } else {
      lines.push(ac.navLabel);
    }
    if (command) lines.push(command);
    if (macro) lines.push(macro);
    return lines;
  }

  private drawTag(ac: Aircraft, p: Pt, box: TagBox, lines: string[], col: string, boxCol: string, selected: string | null,
                  colors: SchemeColors): void {
    const ctx = this.ctx;
    const handed = ac.handedToTower;
    if (!(p.x >= box.x - 3 && p.x <= box.x + box.w + 3 && p.y >= box.y - 3 && p.y <= box.y + box.h + 3)) {
      const nx = Math.min(Math.max(p.x, box.x), box.x + box.w);
      const ny = Math.min(Math.max(p.y, box.y), box.y + box.h);
      ctx.strokeStyle = alpha(col.startsWith("#") ? col : colors.dimText, 0.6);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny); ctx.stroke();
    }
    ctx.fillStyle = alpha(colors.panel, handed ? 0.5 : 0.82);
    roundRect(ctx, box.x, box.y, box.w, box.h, 3);
    ctx.fill();
    ctx.strokeStyle = boxCol.startsWith("#") ? alpha(boxCol, handed ? 0.5 : 0.85) : boxCol;
    ctx.lineWidth = ac.callsign === selected ? 1.6 : 1;
    ctx.stroke();
    ctx.font = `11px ${FONT}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    lines.forEach((l, i) => {
      let c = col;
      if (i === 0) ctx.font = `bold 11px ${FONT}`;
      else ctx.font = `11px ${FONT}`;
      if (l === "MAYDAY" || l === "PAN PAN") c = EMERGENCY_RED;
      else if (i >= 2 && /^M \S+ \d+\/\d+/.test(l) && !handed) c = colors.sid;
      else if (l.startsWith("RWY HDG") && !ac.isOnGround) c = colors.warning;
      else if (i >= 2 && !handed) c = colors.dimText;
      ctx.fillStyle = c;
      ctx.fillText(l, box.x + 5, box.y + 4 + i * TAG_LINE);
    });
  }

  private drawSelectedOverlay(ac: Aircraft, sim: Simulation, airport: AirportPackage, colors: SchemeColors): void {
    const ctx = this.ctx;
    const p = this.toScreen(ac.eastNM, ac.northNM);
    const exit = ac.departure?.exitFix;
    if (exit) {
      const f = sim.fixPosition(exit);
      if (f) {
        const t = this.toScreen(f.east, f.north);
        const last = ac.route[ac.route.length - 1];
        const from = ac.routeIndex < ac.route.length && last ? this.toScreen(last.eastNM, last.northNM) : p;
        ctx.strokeStyle = alpha(colors.sid, 0.9);
        ctx.lineWidth = 1.2;
        ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(t.x, t.y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = colors.sid;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(t.x, t.y, 9, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = colors.sid;
        ctx.font = `600 9px ${FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText("EXIT", t.x, t.y + 12);
      }
    }
    if (ac.routeIndex < ac.route.length) {
      const pts: RoutePoint[] = ac.route.slice(ac.routeIndex);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      for (const r of pts) { const q = this.toScreen(r.eastNM, r.northNM); ctx.lineTo(q.x, q.y); }
      ctx.strokeStyle = colors.background;
      ctx.lineWidth = 5.5;
      ctx.stroke();
      ctx.strokeStyle = colors.route;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([9, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineCap = "butt";
      ctx.font = `bold 10px ${FONT}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      for (const r of pts) {
        const q = this.toScreen(r.eastNM, r.northNM);
        ctx.beginPath();
        ctx.moveTo(q.x, q.y - 5); ctx.lineTo(q.x + 5, q.y); ctx.lineTo(q.x, q.y + 5); ctx.lineTo(q.x - 5, q.y); ctx.closePath();
        ctx.fillStyle = colors.route;
        ctx.fill();
        ctx.fillText(r.id, q.x + 7, q.y - 4);
      }
    }
    if (!ac.handedToTower) {
      const end = ac.levelPoint(ac.targetAltitudeFt, ac.expeditingAltitude);
      if (end) {
        const q = this.toScreen(end.eastNM, end.northNM);
        const rad = (end.bearingDeg * Math.PI) / 180;
        const nx = Math.cos(rad), ny = Math.sin(rad);
        ctx.strokeStyle = colors.selected;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(q.x - nx * 8, q.y - ny * 8);
        ctx.lineTo(q.x + nx * 8, q.y + ny * 8);
        ctx.stroke();
        const ta = airport.transitionAltitudeFt;
        const label = ac.targetAltitudeFt > ta ? `FL${pad3(round(ac.targetAltitudeFt / 100))}` : `${round(ac.targetAltitudeFt)} ft`;
        ctx.fillStyle = colors.selected;
        ctx.font = `10px ${FONT}`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(label, q.x + 10, q.y);
      }
    }
  }

  private drawCompass(colors: SchemeColors): void {
    const ctx = this.ctx;
    const c = { x: this.w / 2, y: this.h / 2 };
    const radius = Math.max(Math.min(this.w, this.h) / 2 - 30, 40);
    ctx.strokeStyle = colors.compass;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(c.x, c.y, radius, 0, Math.PI * 2); ctx.stroke();
    ctx.font = `11px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let deg = 0; deg < 360; deg += 5) {
      const len = deg % 30 === 0 ? 14 : deg % 10 === 0 ? 9 : 5;
      const a = (deg * Math.PI) / 180;
      const dx = Math.sin(a), dy = -Math.cos(a);
      ctx.lineWidth = deg % 30 === 0 ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(c.x + dx * radius, c.y + dy * radius);
      ctx.lineTo(c.x + dx * (radius - len), c.y + dy * (radius - len));
      ctx.stroke();
      if (deg % 10 === 0) {
        ctx.fillStyle = deg % 30 === 0 ? colors.compassLabel : colors.compass;
        ctx.fillText(pad3(deg === 0 ? 360 : deg), c.x + dx * (radius + 16), c.y + dy * (radius + 16));
      }
    }
  }

  /** Screen position of an aircraft, for placing menus. */
  screenOf(ac: Aircraft): Pt {
    return this.toScreen(ac.eastNM, ac.northNM);
  }

  get size(): { w: number; h: number } {
    return { w: this.w, h: this.h };
  }

  localPointUnder(p: Pt): { east: number; north: number } {
    return this.toLocal(p);
  }
}

export function snappedHeading(deg: number): number {
  const s = Math.round(normalized(deg) / 5) * 5;
  return s === 0 || s === 360 ? 360 : s;
}

function signedTurnLabel(from: number, to: number): string {
  let d = (to - from) % 360;
  if (d > 180) d -= 360; else if (d <= -180) d += 360;
  if (Math.abs(d) < 1) return "";
  return d > 0 ? "R" : "L";
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function tagCandidates(w: number, h: number): Pt[] {
  return [
    { x: 10, y: -h - 2 }, { x: 10, y: 6 }, { x: -w - 10, y: -h - 4 }, { x: -w - 10, y: 6 },
    { x: 10, y: -h / 2 }, { x: -w - 10, y: -h / 2 }, { x: -w / 2, y: -h - 12 }, { x: -w / 2, y: 12 },
    { x: 30, y: -h - 24 }, { x: 30, y: 20 }, { x: -w - 30, y: -h - 24 }, { x: -w - 30, y: 20 },
    { x: -w / 2, y: -h - 30 }, { x: -w / 2, y: 30 }, { x: 50, y: -h / 2 }, { x: -w - 50, y: -h / 2 },
  ];
}

function overlap(a: TagBox, b: { x: number; y: number; w: number; h: number }): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function overlapCost(box: TagBox, placed: TagBox[], symbols: Pt[], own: Pt): number {
  let cost = 0;
  for (const p of placed) cost += overlap(box, p);
  for (const s of symbols) {
    if (s === own) continue;
    cost += overlap(box, { x: s.x - 9, y: s.y - 9, w: 18, h: 18 }) * 2;
  }
  return cost;
}
