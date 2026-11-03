import { Option, Schema } from "effect";

export const Theme = Schema.Literals(["light", "dark"]);

export type Theme = typeof Theme.Type;

export const StoredTheme = Schema.fromJsonString(Theme);

/** Stores the chosen theme. Absence means "follow the system". */
export const themeStorageKey = "arctools-theme";

/** Browser chrome colors, matching the `--arc-cream` and `--arc-ink` tokens. */
export const themeColor = {
  light: "#ece2d0",
  dark: "#130918",
} as const satisfies Record<Theme, string>;

/** `data-*` key for elements that keep their transitions while the page swaps instantly. */
export const themeTransitionKey = "theme-transition";

const themeColorMeta = (theme: Theme) =>
  `<meta name="theme-color" data-theme="${theme}" media="(prefers-color-scheme: ${theme})" content="${themeColor[theme]}">`;

// This parser-blocking read is the pre-paint boundary. Runtime storage stays in
// BrowserKeyValueStore; waiting for its hydration Commands would paint too late.
const bootstrap = `(function(){try{var t=JSON.parse(localStorage.getItem(${JSON.stringify(themeStorageKey)}));if(!${JSON.stringify(Theme.literals)}.includes(t))return;document.documentElement.classList.add(t);document.querySelectorAll('meta[name="theme-color"]').forEach(function(m){m.content=${JSON.stringify(themeColor)}[t]})}catch(e){}})()`;

const firstPaintColors = (theme: Theme) =>
  `color-scheme:${theme};background:${themeColor[theme]};color:${themeColor[theme === "dark" ? "light" : "dark"]}`;

const firstPaintStyle = `<style>:root{${firstPaintColors("light")}}:root.dark{${firstPaintColors("dark")}}@media(prefers-color-scheme:dark){:root:not(.light){${firstPaintColors("dark")}}}</style>`;

export const themeHead = `${themeColorMeta("light")}${themeColorMeta("dark")}${firstPaintStyle}<script>${bootstrap}</script>`;

export const ThemeState = Schema.Struct({
  restored: Schema.Boolean,
  system: Schema.Option(Theme),
  override: Schema.Option(Theme),
});

export type ThemeState = typeof ThemeState.Type;

export const initialThemeState = (): ThemeState => ({
  restored: false,
  system: Option.none(),
  override: Option.none(),
});

export const effectiveTheme = (state: ThemeState) =>
  Option.orElse(state.override, () => state.system);
