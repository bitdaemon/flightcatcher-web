import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// The 12 bundled airports are precached with the app shell; every other package is cached on first use, or all at
// once from the airport picker ("Download all for offline use"). Keep this list in step with scripts/prepare-data.mjs.
const BUNDLED = ["katl", "kdfw", "kord", "kden", "klax", "kjfk", "kmco", "klas", "kmia", "ksfo", "kclt", "ksea"];

export default defineConfig({
  // Relative base, so the same build works at https://<user>.github.io/<repo>/ and on any other host or path.
  base: "./",
  build: { target: "es2022", chunkSizeWarningLimit: 800 },
  plugins: [
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      includeAssets: ["icon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png"],
      manifest: {
        name: "flightcATCher",
        short_name: "flightcATCher",
        description: "2D radar approach and departure control game. A game, not a simulator.",
        theme_color: "#080B0A",
        background_color: "#080B0A",
        display: "standalone",
        orientation: "any",
        start_url: "./",
        scope: "./",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "icon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}", "airports/index.json", ...BUNDLED.map((n) => `airports/${n}.json`)],
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
        navigateFallback: "index.html",
        runtimeCaching: [
          {
            urlPattern: /\/airports\/[a-z0-9]+\.json$/,
            handler: "CacheFirst",
            options: { cacheName: "flightcatcher-airports", expiration: { maxEntries: 600 } },
          },
          {
            urlPattern: /^https:\/\/aviationweather\.gov\//,
            handler: "NetworkOnly",
          },
        ],
      },
    }),
  ],
});
