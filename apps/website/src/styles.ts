import * as stylex from "@stylexjs/stylex";

import { breakpoints, colors, fonts } from "./theme.stylex";

const baseStyles = stylex.create({
  element: {
    boxSizing: "border-box",
    animationName: { default: null, [breakpoints.reducedMotion]: "none" },
    transitionProperty: { default: null, [breakpoints.reducedMotion]: "none" },
    scrollBehavior: { default: null, [breakpoints.reducedMotion]: "auto" },
  },
});

export const styles = stylex.create({
  link: {
    color: "inherit",
    textDecoration: "none",
  },
  wrap: {
    width: {
      default: "min(1184px, calc(100% - 96px))",
      [breakpoints.tablet]: "calc(100% - 56px)",
      [breakpoints.mobile]: "calc(100% - 40px)",
    },
    marginLeft: "auto",
    marginRight: "auto",
  },
  eyebrow: {
    fontSize: 10,
    lineHeight: 1.7,
    letterSpacing: 1.8,
    fontWeight: 700,
    color: colors.violet,
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  title: {
    marginTop: 23,
    marginRight: 0,
    marginBottom: 23,
    marginLeft: 0,
    fontFamily: fonts.heading,
    fontSize: {
      default: "clamp(54px, 6.2vw, 86px)",
      [breakpoints.mobile]: 64,
      [breakpoints.narrow]: 56,
    },
    lineHeight: 1.05,
    letterSpacing: { default: -5, [breakpoints.tablet]: -3 },
    fontWeight: 600,
  },
  heading: {
    marginTop: 0,
    marginRight: 0,
    marginBottom: 0,
    marginLeft: 0,
    fontFamily: fonts.heading,
  },
  paragraph: {
    marginTop: 0,
    marginRight: 0,
    marginBottom: 0,
    marginLeft: 0,
  },
  button: {
    display: "inline-flex",
    justifyContent: "center",
    alignItems: "center",
    gap: 26,
    minHeight: 49,
    paddingTop: 13,
    paddingRight: 21,
    paddingBottom: 13,
    paddingLeft: 21,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: 5,
    fontSize: 13,
    fontWeight: 700,
    cursor: { default: "pointer", ":disabled": "wait" },
    transitionProperty: {
      default: "background, transform",
      [breakpoints.reducedMotion]: "none",
    },
    transitionDuration: { default: "0.15s", [breakpoints.reducedMotion]: "0s" },
    transform: { default: null, ":hover": "translateY(-1px)" },
  },
  primary: {
    backgroundColor: { default: colors.violet, ":hover": "#cdbbff" },
    color: "#20182f",
  },
  small: {
    fontSize: 11,
    lineHeight: 1.7,
  },
  muted: {
    color: colors.muted,
  },
  code: {
    fontSize: 11,
    color: "#d1c2fb",
  },
  contentPage: {
    maxWidth: 740,
    paddingTop: { default: 58, [breakpoints.mobile]: 35 },
    paddingBottom: { default: 85, [breakpoints.mobile]: 55 },
    minHeight: "calc(100vh - 195px)",
  },
  pageTitle: {
    fontSize: "clamp(36px, 5vw, 50px)",
    letterSpacing: -2,
    marginTop: 35,
    lineHeight: 1.15,
  },
  interactive: {
    WebkitTapHighlightColor: "transparent",
    outlineWidth: { default: null, ":focus-visible": 3 },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "#d0bfff" },
    outlineOffset: { default: null, ":focus-visible": 5 },
  },
});

export const elementClass = (
  ...appliedStyles: ReadonlyArray<stylex.StaticStyles>
): string => stylex.props(baseStyles.element, appliedStyles).className ?? "";
