// Colour schemes, ported from SimCore/DisplayScheme.swift.
export interface SchemeColors {
  background: string;
  panel: string;
  panelBorder: string;
  rowHighlight: string;
  text: string;
  dimText: string;
  heading: string;
  selected: string;
  compass: string;
  compassLabel: string;
  rings: string;
  runway: string;
  runwayCentreline: string;
  fix: string;
  star: string;
  sid: string;
  approach: string;
  route: string;
  aircraft: string;
  ok: string;
  warning: string;
  alert: string;
  controller: string;
  pilot: string;
  system: string;
}
export interface DisplayScheme { id: string; name: string; isLight: boolean; colors: SchemeColors; }
export const SCHEMES: DisplayScheme[] = [
  { id: "tactical", name: "Tactical", isLight: false, colors: { background: "#080B0A", panel: "#0E1513", panelBorder: "#1C2623", rowHighlight: "#13201B", text: "#C9D4CF", dimText: "#7F8F88", heading: "#4FD1A5", selected: "#FFE680", compass: "#3A4A43", compassLabel: "#7F8F88", rings: "#16211D", runway: "#C9D4CF", runwayCentreline: "#5F6F68", fix: "#5D6D66", star: "#6FB3FF", sid: "#D99BFF", approach: "#4FD1A5", route: "#F2B84B", aircraft: "#FFFFFF", ok: "#4FD1A5", warning: "#F2B84B", alert: "#FF6B6B", controller: "#C9D4CF", pilot: "#4FD1A5", system: "#7F8F88" } },
  { id: "slate", name: "Slate", isLight: false, colors: { background: "#1B2430", panel: "#252F3D", panelBorder: "#3F4E63", rowHighlight: "#34445A", text: "#E6EAF0", dimText: "#8D9BAE", heading: "#6CB6FF", selected: "#FFE14D", compass: "#8D9BAE", compassLabel: "#B4C0D0", rings: "#2F3E52", runway: "#CDD5E0", runwayCentreline: "#6C7A8E", fix: "#8D9BAE", star: "#35D0BA", sid: "#B28DFF", approach: "#FF6EB4", route: "#FF9338", aircraft: "#FFFFFF", ok: "#6FCF97", warning: "#F5A524", alert: "#FF5A5F", controller: "#6CB6FF", pilot: "#E6EAF0", system: "#8D9BAE" } },
  { id: "midnight", name: "Midnight", isLight: false, colors: { background: "#0B1020", panel: "#141B33", panelBorder: "#2A3560", rowHighlight: "#1F2A4D", text: "#E8ECFF", dimText: "#8791C0", heading: "#7AA2FF", selected: "#FFE14D", compass: "#7C86B8", compassLabel: "#A9B3E0", rings: "#1C2547", runway: "#A8B6EE", runwayCentreline: "#5A6699", fix: "#7C86B8", star: "#2EE6A6", sid: "#C77DFF", approach: "#FF5FA2", route: "#FF8A3D", aircraft: "#FFFFFF", ok: "#5BE49B", warning: "#FFB020", alert: "#FF4D5E", controller: "#7AA2FF", pilot: "#E8ECFF", system: "#8791C0" } },
  { id: "graphite", name: "Graphite", isLight: false, colors: { background: "#17191C", panel: "#22262B", panelBorder: "#3B4148", rowHighlight: "#2E343B", text: "#ECEFF2", dimText: "#9AA2AB", heading: "#8AB4F8", selected: "#FFE14D", compass: "#8B939C", compassLabel: "#B8BFC7", rings: "#2A2E33", runway: "#C2C8CF", runwayCentreline: "#6A727B", fix: "#8B939C", star: "#4DD0C4", sid: "#BA9BFF", approach: "#FF7EB6", route: "#FF9338", aircraft: "#FFFFFF", ok: "#7BD88F", warning: "#FFB300", alert: "#FF6B6B", controller: "#8AB4F8", pilot: "#ECEFF2", system: "#9AA2AB" } },
  { id: "phosphor", name: "Phosphor", isLight: false, colors: { background: "#04110A", panel: "#0A1E12", panelBorder: "#1B4A2C", rowHighlight: "#123222", text: "#C8FFD8", dimText: "#6FAE85", heading: "#5CFF9A", selected: "#FFF066", compass: "#3FA866", compassLabel: "#8FE8B0", rings: "#0D2A18", runway: "#B8E8C8", runwayCentreline: "#3C7A55", fix: "#4F9A6C", star: "#3DDCFF", sid: "#C58CFF", approach: "#FF6FB5", route: "#FF9640", aircraft: "#FFFFFF", ok: "#5CFF9A", warning: "#FFC400", alert: "#FF4D4D", controller: "#5CFF9A", pilot: "#C8FFD8", system: "#6FAE85" } },
  { id: "amber", name: "Amber", isLight: false, colors: { background: "#120A00", panel: "#1E1405", panelBorder: "#4A3410", rowHighlight: "#33230A", text: "#FFE3B0", dimText: "#B08A4A", heading: "#FFB84D", selected: "#FFE14D", compass: "#A37A33", compassLabel: "#D9B26A", rings: "#2A1C08", runway: "#E6D2A8", runwayCentreline: "#7A5A25", fix: "#9C7B40", star: "#45D9E8", sid: "#B794FF", approach: "#FF6FA8", route: "#7DFF9B", aircraft: "#FFFFFF", ok: "#7DFF9B", warning: "#FF9F1C", alert: "#FF4D4D", controller: "#FFB84D", pilot: "#FFE3B0", system: "#B08A4A" } },
  { id: "daylight", name: "Daylight", isLight: true, colors: { background: "#F4F6F9", panel: "#FFFFFF", panelBorder: "#C3CBD6", rowHighlight: "#E3E9F1", text: "#1B2430", dimText: "#5C6B7E", heading: "#0B63CE", selected: "#8A00D4", compass: "#7C8A9C", compassLabel: "#4A5868", rings: "#DDE3EB", runway: "#39465A", runwayCentreline: "#8A97A8", fix: "#6B7B8E", star: "#00897B", sid: "#3D5AFE", approach: "#D6007A", route: "#E65100", aircraft: "#0A0F1A", ok: "#1B8A4B", warning: "#B26A00", alert: "#D32F2F", controller: "#0B63CE", pilot: "#1B2430", system: "#5C6B7E" } },
  { id: "paper", name: "Paper", isLight: true, colors: { background: "#F3ECDD", panel: "#FBF7EE", panelBorder: "#CDBF9F", rowHighlight: "#E8DDC4", text: "#2B2218", dimText: "#7A6A52", heading: "#1F5FA8", selected: "#8A00D4", compass: "#8C7B5E", compassLabel: "#5A4A32", rings: "#E2D7BC", runway: "#3A2F20", runwayCentreline: "#9A8A6C", fix: "#7A6A52", star: "#00796B", sid: "#3D5AFE", approach: "#C2185B", route: "#E65100", aircraft: "#120D06", ok: "#2E7D32", warning: "#A86400", alert: "#C62828", controller: "#1F5FA8", pilot: "#2B2218", system: "#7A6A52" } },
  { id: "high-contrast", name: "High contrast", isLight: false, colors: { background: "#000000", panel: "#0D0D0D", panelBorder: "#8C8C8C", rowHighlight: "#2B2B2B", text: "#FFFFFF", dimText: "#BFBFBF", heading: "#00E5FF", selected: "#FFEB3B", compass: "#A6A6A6", compassLabel: "#E6E6E6", rings: "#262626", runway: "#C9C9C9", runwayCentreline: "#808080", fix: "#A6A6A6", star: "#00E58F", sid: "#B388FF", approach: "#FF4081", route: "#FF9100", aircraft: "#FFFFFF", ok: "#00E676", warning: "#FFC400", alert: "#FF1744", controller: "#00E5FF", pilot: "#FFFFFF", system: "#BFBFBF" } },
  { id: "colour-blind-safe", name: "Colour-blind safe", isLight: false, colors: { background: "#14181F", panel: "#1F2530", panelBorder: "#3C4658", rowHighlight: "#2B3342", text: "#F0F2F5", dimText: "#9AA5B5", heading: "#56B4E9", selected: "#F0E442", compass: "#8794A8", compassLabel: "#B9C3D1", rings: "#232A36", runway: "#B4BAC3", runwayCentreline: "#667284", fix: "#8794A8", star: "#56B4E9", sid: "#CC79A7", approach: "#009E73", route: "#FFFFFF", aircraft: "#FFFFFF", ok: "#009E73", warning: "#E69F00", alert: "#D55E00", controller: "#56B4E9", pilot: "#F0F2F5", system: "#9AA5B5" } },
  { id: "solar-dark", name: "Solar dark", isLight: false, colors: { background: "#002B36", panel: "#073642", panelBorder: "#586E75", rowHighlight: "#0F4552", text: "#EEE8D5", dimText: "#93A1A1", heading: "#3AA0E8", selected: "#FFD84A", compass: "#7B9096", compassLabel: "#A9B8B8", rings: "#0B3B47", runway: "#C9D2C6", runwayCentreline: "#62797F", fix: "#7B9096", star: "#2AA198", sid: "#8C90E8", approach: "#E04C96", route: "#F07A3A", aircraft: "#FDF6E3", ok: "#9BB800", warning: "#E0A100", alert: "#F0534F", controller: "#3AA0E8", pilot: "#EEE8D5", system: "#93A1A1" } },
  { id: "nord", name: "Nord", isLight: false, colors: { background: "#2E3440", panel: "#3B4252", panelBorder: "#4C566A", rowHighlight: "#434C5E", text: "#ECEFF4", dimText: "#9FAABD", heading: "#88C0D0", selected: "#FFE08A", compass: "#8A96AB", compassLabel: "#B7C1D3", rings: "#3A4152", runway: "#C4CCDA", runwayCentreline: "#6B7790", fix: "#8A96AB", star: "#7BE0B4", sid: "#B48EF0", approach: "#FF7FA8", route: "#FF9A52", aircraft: "#FFFFFF", ok: "#A3D68C", warning: "#EBB04B", alert: "#FF6B72", controller: "#88C0D0", pilot: "#ECEFF4", system: "#9FAABD" } },
  { id: "dracula", name: "Dracula", isLight: false, colors: { background: "#282A36", panel: "#343746", panelBorder: "#4F5370", rowHighlight: "#3E4155", text: "#F8F8F2", dimText: "#A0A6C6", heading: "#8BE9FD", selected: "#F1FA8C", compass: "#8E94B4", compassLabel: "#BDC2DC", rings: "#32354A", runway: "#C8CCE0", runwayCentreline: "#6D7396", fix: "#8E94B4", star: "#50FA7B", sid: "#BD93F9", approach: "#FF79C6", route: "#FFA04D", aircraft: "#FFFFFF", ok: "#50FA7B", warning: "#F1C232", alert: "#FF5555", controller: "#8BE9FD", pilot: "#F8F8F2", system: "#A0A6C6" } },
  { id: "ocean", name: "Ocean", isLight: false, colors: { background: "#06232B", panel: "#0C3440", panelBorder: "#1F5B6B", rowHighlight: "#124452", text: "#E2F6FA", dimText: "#7FB0BC", heading: "#5CC8FF", selected: "#FFE14D", compass: "#5E9AA8", compassLabel: "#9BCBD6", rings: "#0E3B48", runway: "#A9D2DC", runwayCentreline: "#4C8594", fix: "#5E9AA8", star: "#6BF0A8", sid: "#C49BFF", approach: "#FF6FA8", route: "#FF8F3E", aircraft: "#FFFFFF", ok: "#6BF0A8", warning: "#FFB52E", alert: "#FF5A6A", controller: "#5CC8FF", pilot: "#E2F6FA", system: "#7FB0BC" } },
  { id: "dusk", name: "Dusk", isLight: false, colors: { background: "#1E1530", panel: "#2A1F40", panelBorder: "#4C3C73", rowHighlight: "#382A55", text: "#F1EAFF", dimText: "#A99BC9", heading: "#9CB5FF", selected: "#FFE14D", compass: "#8F82B3", compassLabel: "#C3B8DE", rings: "#2D2245", runway: "#C9BFE6", runwayCentreline: "#6C5F94", fix: "#8F82B3", star: "#4DE0C0", sid: "#A98BFF", approach: "#FF6CB0", route: "#FF9140", aircraft: "#FFFFFF", ok: "#6FE3A0", warning: "#FFB92E", alert: "#FF5A66", controller: "#9CB5FF", pilot: "#F1EAFF", system: "#A99BC9" } },
];
export const DEFAULT_SCHEME = "tactical";
export function scheme(id: string): DisplayScheme { return SCHEMES.find((s) => s.id === id) ?? SCHEMES[0]; }

/** "#RRGGBB" with an alpha in 0...1, as an rgba() string. */
export function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function applyScheme(s: DisplayScheme): void {
  const r = document.documentElement.style;
  for (const [k, v] of Object.entries(s.colors)) r.setProperty("--" + k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()), v);
  document.documentElement.dataset.light = String(s.isLight);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", s.colors.background);
}
