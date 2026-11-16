# flightcATCher for the web

The browser version of [flightcATCher](https://github.com/bitdaemon/flightcatcher), the 2D radar approach and departure
control game for macOS. This repository holds only the web version; the Mac app lives in its own repository. It is a progressive web app
(PWA): it installs to the home screen or dock, and works offline once loaded.

> **This is a game, not a simulator.** The same disclaimer as the macOS app applies: invented traffic, simplified
> procedures and performance, airport data that may be out of date. Do not use it for real-world navigation, flight
> planning, or controller or pilot training.

## What is in it

- **The simulation** (`src/sim/`) is a TypeScript port of the Mac app's `SimCore`: aircraft performance, routes, ILS, RNAV and
  visual approaches, departures with SIDs or runway heading, wind and runway selection, separation monitoring, random
  events, phraseology and scoring. It keeps SimCore's deterministic design (SplitMix64, one tick per simulated second),
  so a fixed traffic seed replays the same session.
- **The scope** (`src/ui/scope.ts`) is a canvas renderer with pan, zoom (wheel, pinch, buttons), draggable tags,
  velocity vectors, history trails, the selected aircraft's route and level-off point, and conflict lines.
- **Controls**: the command bar (same codes as the Mac app, chains, Tab completion, ↑ history), a radial menu on
  right-click or long-press (HDG by pointing, ALT and SPD pickers, DCT by clicking a fix, APP list, HO, MAINT, OWN,
  LUP and T/O), and quick buttons on the selected strip.
- **Panels**: aircraft strips, radio log (with each instruction's command-bar form), airport info. On a phone they open
  one at a time as sheets.
- Settings (traffic presets and ranges, aircraft types, random events, wind mode, airspace size, colour schemes,
  layers, ICAO number style, optional spoken radio), a commands and scoring reference, and the end-of-session debrief
  with a best-scores table per airport.

### Airports and offline use

The airport packages live in `data/airports/` (one JSON file per airport plus `airports-index.json`), built from FAA
CIFP data by `Tools/cifp_to_package.py` in the Mac app's repository. To update them, regenerate them there and copy the
files into `data/airports/`. `scripts/prepare-data.mjs` copies them (minified) into `public/airports/` at build time,
with an index that records each package's size and whether it ships with the app.

- **Included with the app (precached by the service worker):** the 12 busiest US airports by 2025 passenger boardings:
  KATL, KDFW, KORD, KDEN, KLAX, KJFK, KMCO, KLAS, KMIA, KSFO, KCLT, KSEA. Atlanta is the default.
- **Everything else** (the other 494) loads from the site the first time it is picked and is cached from then on.
- **Download all for offline use** in the airport list fetches every remaining package into the browser's cache
  (about 8 MB), with progress and cancel. *Remove downloads* frees the space again; the 12 included airports stay.

To change the included set, edit `BUNDLED` in both `scripts/prepare-data.mjs` and `vite.config.ts`.

### Macros

Saved sequences of instructions with optional triggers, per airport, kept in the browser (`localStorage`). Edit them
with **MACROS** in the top bar; run one with `CALLSIGN mac NAME` or **MAC** in the aircraft's radial menu, stop it with
`mac-`. Same syntax and rules as the Mac app (`src/sim/macro.ts`):

```
s210
at CAPE: d30, s180
when alt<4000: i4r
when spd<=180: h270l
```

### Runway view

**RWY** in the top bar opens the runways close up (`src/ui/runwayMap.ts`): green when free, yellow while an arrival is
cleared to the runway, red while a departure is lined up or rolling or an arrival is about to touch down.

### Not ported

The test spawner and the debug log (on purpose), and
the Foundation Models radio voice (the browser's speech synthesis is offered instead). Live METAR wind works where the
browser can reach `aviationweather.gov`; otherwise the wind drifts randomly, as in the Mac app when no observation can
be had.

## Develop

Requires Node 20 or later.

```sh
npm install
npm run dev      # copies the airport data, then starts Vite on http://localhost:5173
npm test         # simulation and macro tests (traffic at each included airport, an ILS to a landing, determinism, macros)
npm run build    # type-checks and builds the PWA into dist/
npm run preview  # serves dist/, service worker included
```

## Deploy to GitHub Pages

`.github/workflows/deploy.yml` tests, builds and publishes on every push to `main`. One-time setup: in the repository on GitHub, **Settings → Pages → Build and deployment → Source: GitHub Actions**.
The site then appears at `https://<user>.github.io/<repo>/`. The build uses relative paths, so it also works from any
other static host or sub-folder.

When a new version is deployed, open copies of the game show a "new version is ready" prompt rather than switching
mid-session.

## Licence

Apache License 2.0, see `LICENSE`. Keep the `NOTICE` file with any redistribution. Airport data sources are listed in
`DATA-SOURCES.md`.
