import * as stylex from "@stylexjs/stylex";

export const colors = stylex.defineConsts({
  muted: "#aaa9b1",
  violet: "#baa5fc",
  line: "#343337",
});

export const fonts = stylex.defineConsts({
  body: '"DM Sans", sans-serif',
  heading: '"Space Grotesk", sans-serif',
});

export const breakpoints = stylex.defineConsts({
  tablet: "@media (max-width: 960px)",
  mobile: "@media (max-width: 700px)",
  narrow: "@media (max-width: 380px)",
  reducedMotion: "@media (prefers-reduced-motion: reduce)",
});
