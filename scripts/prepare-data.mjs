// Copies the airport packages from data/airports into public/airports (minified), and writes an index
// with each package's size and whether it ships inside the app (precached by the service worker) or is an optional
// download for offline use. Runs before `vite` and `vite build`.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "data", "airports");
const out = join(here, "..", "public", "airports");

// The 12 busiest US airports by 2025 passenger boardings (FAA preliminary CY2025 enplanements).
export const BUNDLED = ["katl", "kdfw", "kord", "kden", "klax", "kjfk", "kmco", "klas", "kmia", "ksfo", "kclt", "ksea"];

if (!existsSync(src)) {
  console.error(`prepare-data: airport packages not found at ${src}`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });

const index = JSON.parse(readFileSync(join(src, "airports-index.json"), "utf8"));
const files = new Set(readdirSync(src).filter((f) => f.endsWith(".json") && f !== "airports-index.json"));
const entries = [];
let total = 0;
let bundledBytes = 0;
for (const e of index) {
  const name = e.icao.toLowerCase();
  if (!files.has(name + ".json")) continue;
  const text = JSON.stringify(JSON.parse(readFileSync(join(src, name + ".json"), "utf8")));
  writeFileSync(join(out, name + ".json"), text);
  const bytes = Buffer.byteLength(text);
  const bundled = BUNDLED.includes(name);
  total += bytes;
  if (bundled) bundledBytes += bytes;
  entries.push({ ...e, bytes, bundled });
}
const missing = BUNDLED.filter((n) => !entries.some((e) => e.icao.toLowerCase() === n));
if (missing.length) {
  console.error("prepare-data: bundled airports missing: " + missing.join(", "));
  process.exit(1);
}
writeFileSync(join(out, "index.json"), JSON.stringify(entries));
console.log(`prepare-data: ${entries.length} airports, ${(total / 1e6).toFixed(1)} MB; bundled ${BUNDLED.length}, ${(bundledBytes / 1e6).toFixed(1)} MB`);
