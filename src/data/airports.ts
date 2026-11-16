// Airport data: the index, single packages, and the offline download of every package.
// The 12 bundled packages are precached by the service worker with the app. The others are fetched when first
// chosen (and cached), or all at once with `downloadAll` so the whole game works offline.
import type { AirportIndexEntry, AirportPackage } from "../sim/airport";

export const AIRPORT_CACHE = "flightcatcher-airports";

const url = (path: string) => new URL(path, document.baseURI).href;
export const packageURL = (icao: string) => url(`airports/${icao.toLowerCase()}.json`);

let indexPromise: Promise<AirportIndexEntry[]> | null = null;

export function loadIndex(): Promise<AirportIndexEntry[]> {
  indexPromise ??= fetch(url("airports/index.json"))
    .then((r) => {
      if (!r.ok) throw new Error(`airport index: HTTP ${r.status}`);
      return r.json() as Promise<AirportIndexEntry[]>;
    })
    .then((list) => list.sort((a, b) => (a.city ?? a.name).localeCompare(b.city ?? b.name)))
    .catch((e) => {
      indexPromise = null;
      throw e;
    });
  return indexPromise;
}

export async function loadPackage(icao: string): Promise<AirportPackage> {
  const u = packageURL(icao);
  // Cache first, so a downloaded airport loads offline even before the service worker controls the page.
  if ("caches" in window) {
    const hit = await caches.match(u, { ignoreSearch: true });
    if (hit) return hit.json();
  }
  const res = await fetch(u);
  if (!res.ok) throw new Error(`${icao.toUpperCase()}: HTTP ${res.status}`);
  if ("caches" in window) {
    try {
      const cache = await caches.open(AIRPORT_CACHE);
      await cache.put(u, res.clone());
    } catch { /* storage full or unavailable: still playable online */ }
  }
  return res.json();
}

/** ICAO codes (upper case) whose package is available without the network. */
export async function offlineAirports(index: AirportIndexEntry[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!("caches" in window)) return out;
  await Promise.all(index.map(async (e) => {
    if (await caches.match(packageURL(e.icao), { ignoreSearch: true })) out.add(e.icao);
  }));
  return out;
}

export interface DownloadProgress {
  done: number;
  total: number;
  bytes: number;
  failed: string[];
}

/**
 * Downloads every package that is not yet available offline. `onProgress` is called after each file; `signal`
 * cancels. Six requests run at once.
 */
export async function downloadAll(index: AirportIndexEntry[], onProgress: (p: DownloadProgress) => void,
                                  signal: AbortSignal): Promise<DownloadProgress> {
  const have = await offlineAirports(index);
  const todo = index.filter((e) => !have.has(e.icao));
  const cache = await caches.open(AIRPORT_CACHE);
  const p: DownloadProgress = { done: 0, total: todo.length, bytes: 0, failed: [] };
  onProgress(p);
  let next = 0;
  const worker = async () => {
    while (next < todo.length && !signal.aborted) {
      const e = todo[next++];
      try {
        const res = await fetch(packageURL(e.icao), { signal });
        if (!res.ok) throw new Error(String(res.status));
        await cache.put(packageURL(e.icao), res.clone());
        p.bytes += e.bytes ?? 0;
      } catch {
        if (!signal.aborted) p.failed.push(e.icao);
      }
      p.done++;
      onProgress(p);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return p;
}

/** Removes downloaded packages, keeping the bundled ones (they live in the service worker's precache). */
export async function removeDownloads(index: AirportIndexEntry[], keep: string | null): Promise<void> {
  const cache = await caches.open(AIRPORT_CACHE);
  await Promise.all(index.filter((e) => !e.bundled && e.icao !== keep).map((e) => cache.delete(packageURL(e.icao))));
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}

export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return Math.round(n / 1e3) + " kB";
  return n + " B";
}
