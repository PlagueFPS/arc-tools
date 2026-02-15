import type { LinkProps } from "@tanstack/react-router";

interface NavRoute extends LinkProps {
  label: string;
}

export const NAV_ROUTES: NavRoute[] = [
  {
    label: "Features",
    to: "/",
    hash: "features",
  },
  {
    label: "Commands",
    to: "/",
    hash: "commands",
  },
];
