// Small numeric helpers that mirror Swift behaviour, so the port behaves like SimCore.

/** Swift's `.rounded()`: half away from zero. */
export function round(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/** Swift `Int` division: truncates toward zero. */
export function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

export function hypot(a: number, b: number): number {
  return Math.sqrt(a * a + b * b);
}

/** Degrees in [0, 360). */
export function normalized(degrees: number): number {
  const r = degrees % 360;
  return r < 0 ? r + 360 : r;
}

/** True bearing of a displacement (east, north). */
export function bearingDeg(east: number, north: number): number {
  return normalized((Math.atan2(east, north) * 180) / Math.PI);
}

/** Signed turn from one heading to another, in (-180, 180]. Positive is a right turn. */
export function signedTurn(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}

export function pad3(n: number): string {
  const s = String(Math.max(0, n));
  return s.length >= 3 ? s : "0".repeat(3 - s.length) + s;
}

export function fmt1(x: number): string {
  return x.toFixed(1);
}

export function pad2(n: number): string {
  const s = String(n);
  return s.length >= 2 ? s : "0" + s;
}
