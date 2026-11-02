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

export const themeHead = `${themeColorMeta("light")}${themeColorMeta("dark")}`;

export const ThemeState = Schema.Struct({
  system: Schema.Option(Theme),
  override: Schema.Option(Theme),
});

export type ThemeState = typeof ThemeState.Type;

export const initialThemeState = (): ThemeState => ({
  system: Option.none(),
  override: Option.none(),
});

export const effectiveTheme = (state: ThemeState) =>
  Option.orElse(state.override, () => state.system);
