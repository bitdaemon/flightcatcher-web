// Live METAR from the NOAA Aviation Weather Center. Browsers may block the request (CORS or offline); the game then
// keeps a randomly drifting wind, as the macOS app does when no observation can be had.
import { parseMetarJSON, type WeatherReport } from "../sim/weather";

export async function fetchMetar(icao: string): Promise<WeatherReport | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(icao.toUpperCase())}&format=json`,
      { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) return null;
    return parseMetarJSON(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
