// The runway view: the runways drawn large, as if zoomed in on the airport. Green when free; red while a departure is
// lined up, rolling or just airborne, or an arrival is about to touch down; yellow while an arrival is cleared for an
// approach to it. Aircraft near the runways are drawn too. Ported from FlightcatcherApp/RunwayMapView.swift.
import { LocalProjection, referenceProjection, type AirportPackage } from "../sim/airport";
import { oppositeRunway, type Simulation } from "../sim/simulation";
import { alpha, type SchemeColors } from "./theme";

const FREE = "#4DCC6B";
const BUSY = "#F2524D";
const ASSIGNED = "#FFD140";
const FONT = '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace';

interface Strip {
  endA: string;
  endB: string;
  a: { east: number; north: number };
  b: { east: number; north: number };
}

export class RunwayMap {
  private ctx: CanvasRenderingContext2D;
  private strips: Strip[] = [];
  private airport: AirportPackage | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  private buildStrips(airport: AirportPackage): void {
    this.airport = airport;
    const proj = referenceProjection(airport);
    const seen = new Set<string>();
    this.strips = [];
    for (const runway of airport.runways) {
      const opposite = oppositeRunway(runway.id);
      if (seen.has(runway.id) || seen.has(opposite)) continue;
      seen.add(runway.id);
      const start = proj.nm(runway.thresholdLat, runway.thresholdLon);
      let far = start;
      const other = airport.runways.find((r) => r.id === opposite);
      if (other) far = proj.nm(other.thresholdLat, other.thresholdLon);
      else {
        const o = LocalProjection.offset(runway.trueBearingDeg, runway.lengthM / 1852);
        far = { east: start.east + o.east, north: start.north + o.north };
      }
      this.strips.push({ endA: runway.id, endB: opposite, a: start, b: far });
    }
  }

  draw(sim: Simulation | null, airport: AirportPackage | null, selected: string | null, colors: SchemeColors): void {
    const canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!sim || !airport) return;
    if (airport !== this.airport) this.buildStrips(airport);
    const strips = this.strips;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (strips.length === 0) {
      ctx.fillStyle = colors.dimText;
      ctx.font = `12px ${FONT}`;
      ctx.fillText("no runways", w / 2, h / 2);
      return;
    }
    // Fit all strips with a margin.
    const xs = strips.flatMap((s) => [s.a.east, s.b.east]);
    const ys = strips.flatMap((s) => [s.a.north, s.b.north]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const spanX = Math.max(maxX - minX, 0.5), spanY = Math.max(maxY - minY, 0.5);
    const margin = 36;
    const scale = Math.min((w - 2 * margin) / spanX, (h - 2 * margin) / spanY);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const pt = (east: number, north: number) => ({ x: w / 2 + (east - cx) * scale, y: h / 2 - (north - cy) * scale });

    const uses = sim.runwayUses();
    // Arrivals cleared for an approach, by runway end.
    const cleared = new Map<string, string[]>();
    for (const ac of sim.aircraft) {
      if (ac.departure || ac.landed || !ac.approach) continue;
      const id = ac.approach.ils.runwayId;
      cleared.set(id, [...(cleared.get(id) ?? []), ac.callsign]);
    }
    const open = sim.openRunways;
    const known = new Set(sim.runwayStatuses.map((s) => s.id));

    for (const strip of strips) {
      const use = uses.get(strip.endA) ?? uses.get(strip.endB);
      const here = [...(cleared.get(strip.endA) ?? []), ...(cleared.get(strip.endB) ?? [])];
      const colour = use ? BUSY : here.length === 0 ? FREE : ASSIGNED;
      const p = pt(strip.a.east, strip.a.north), q = pt(strip.b.east, strip.b.north);
      ctx.lineCap = "butt";
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y);
      ctx.strokeStyle = colors.background; ctx.lineWidth = 13; ctx.stroke();
      ctx.strokeStyle = alpha(colour, 0.85); ctx.lineWidth = 9; ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.lineWidth = 1; ctx.setLineDash([6, 6]); ctx.stroke(); ctx.setLineDash([]);

      const dx = q.x - p.x, dy = q.y - p.y;
      const len = Math.max(Math.hypot(dx, dy), 1);
      const ux = dx / len, uy = dy / len;
      for (const [end, at, sign] of [[strip.endA, p, -1], [strip.endB, q, 1]] as const) {
        const isOpen = known.has(end) ? open.has(end) : false;
        ctx.font = `${isOpen ? "bold " : ""}11px ${FONT}`;
        ctx.fillStyle = isOpen ? colors.text : colors.dimText;
        ctx.fillText(end, at.x + ux * sign * 16, at.y + uy * sign * 16);
      }
      const mid = { x: (p.x + q.x) / 2 - uy * 14, y: (p.y + q.y) / 2 + ux * 14 };
      ctx.font = `bold 10px ${FONT}`;
      if (use) {
        ctx.fillStyle = BUSY;
        ctx.fillText(use.kind === "departing" ? `T/O ${use.callsign}` : `LDG ${use.callsign}`, mid.x, mid.y);
      } else if (here.length) {
        ctx.fillStyle = ASSIGNED;
        ctx.fillText("APP " + here.slice(0, 2).join(" ") + (here.length > 2 ? ` +${here.length - 2}` : ""), mid.x, mid.y);
      }
    }

    // Aircraft inside the view: a small triangle along the heading, with the callsign.
    ctx.textAlign = "left";
    for (const ac of sim.aircraft) {
      if (ac.handedToTower && !ac.approach) continue;
      const a = pt(ac.eastNM, ac.northNM);
      if (a.x <= 0 || a.x >= w || a.y <= 0 || a.y >= h) continue;
      const hd = (ac.headingDeg * Math.PI) / 180;
      const f = { x: Math.sin(hd), y: -Math.cos(hd) };
      const s = { x: -f.y, y: f.x };
      const sel = ac.callsign === selected;
      ctx.beginPath();
      ctx.moveTo(a.x + f.x * 6, a.y + f.y * 6);
      ctx.lineTo(a.x - f.x * 4 + s.x * 3.5, a.y - f.y * 4 + s.y * 3.5);
      ctx.lineTo(a.x - f.x * 4 - s.x * 3.5, a.y - f.y * 4 - s.y * 3.5);
      ctx.closePath();
      ctx.fillStyle = sel ? colors.selected : colors.aircraft;
      ctx.fill();
      ctx.font = `9px ${FONT}`;
      ctx.fillStyle = sel ? colors.selected : colors.dimText;
      ctx.fillText(ac.callsign, a.x + 8, a.y - 6);
    }
  }

  /** The aircraft under a point in the view, for selecting from it. */
  hit(sim: Simulation, x: number, y: number): string | null {
    const canvas = this.canvas;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const strips = this.strips;
    if (!strips.length) return null;
    const xs = strips.flatMap((s) => [s.a.east, s.b.east]);
    const ys = strips.flatMap((s) => [s.a.north, s.b.north]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const scale = Math.min((w - 72) / Math.max(maxX - minX, 0.5), (h - 72) / Math.max(maxY - minY, 0.5));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    let best: string | null = null, bestD = 14;
    for (const ac of sim.aircraft) {
      const px = w / 2 + (ac.eastNM - cx) * scale, py = h / 2 - (ac.northNM - cy) * scale;
      const d = Math.hypot(px - x, py - y);
      if (d < bestD) { bestD = d; best = ac.callsign; }
    }
    return best;
  }
}
