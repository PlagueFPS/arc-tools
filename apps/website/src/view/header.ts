import { Button, Nav } from "@foldkit/ui";
import { Array as Arr, Option } from "effect";
import type { Html } from "foldkit/html";

import type { ApplicationViewBuilder } from "../composition";
import { cn } from "../lib/utils";
import { Message } from "../message";
import type { Model } from "../model";
import { ApplicationRoute, connectRouter, homeRouter } from "../route";
import { effectiveTheme, themeTransitionKey } from "../theme";
import { brandMark, themeIcon } from "./icons";
import { wrap } from "./shared";

/** Matches the command filter's indicator so the site moves with one voice. */
const iconMotion =
  "[grid-area:1/1] grid place-items-center transition-[opacity,rotate,scale,filter] duration-250 ease-[cubic-bezier(.23,1,.32,1)] group-focus-visible:transition-none";

const themeSwitcher = (model: Model, h: ApplicationViewBuilder): Html =>
  Button.view(
    {
      type: "button",
      isDisabled:
        !model.theme.restored || Option.isNone(effectiveTheme(model.theme)),
      onClick: Message.ClickedToggleTheme(),
      toView: (attributes) =>
        h.button(
          [
            ...attributes.button,
            h.Id("theme-switcher"),
            h.Class(
              "group -mr-[11px] grid size-10 place-items-center rounded-[5px] text-muted-foreground transition-[color,background-color,scale] duration-150 ease-out hover:bg-muted hover:text-foreground [&:active:not(:focus-visible)]:scale-[.95] max-[620px]:-mr-2.5",
            ),
          ],
          [
            h.span([h.Class("sr-only dark:hidden")], ["Switch to dark theme"]),
            h.span(
              [h.Class("sr-only hidden dark:block")],
              ["Switch to light theme"],
            ),
            h.span(
              [
                h.DataAttribute(themeTransitionKey, ""),
                h.Class(
                  cn(
                    iconMotion,
                    "dark:-rotate-90 dark:scale-[.6] dark:opacity-0 dark:blur-[2px]",
                  ),
                ),
              ],
              [themeIcon("light", h)],
            ),
            h.span(
              [
                h.DataAttribute(themeTransitionKey, ""),
                h.Class(
                  cn(
                    iconMotion,
                    "rotate-90 scale-[.6] opacity-0 blur-[2px] dark:rotate-0 dark:scale-100 dark:opacity-100 dark:blur-none",
                  ),
                ),
              ],
              [themeIcon("dark", h)],
            ),
          ],
        ),
    },
    h,
  );

export const view = (model: Model, h: ApplicationViewBuilder): Html =>
  h.header(
    [
      h.Class(
        cn(
          wrap,
          "flex h-24 items-center justify-between gap-3 border-b border-border max-[620px]:h-[76px]",
        ),
      ),
    ],
    [
      h.a(
        [
          h.Href(homeRouter()),
          h.AriaLabel("ARCToolsBot home"),
          h.Class(
            "flex items-center gap-2.5 text-2xl font-bold tracking-[-1px] max-[620px]:text-xl",
          ),
        ],
        [brandMark(h), "ARCToolsBot"],
      ),
      h.div(
        [h.Class("flex items-center gap-5 max-[620px]:gap-3")],
        [
          Nav.view({
            items: ApplicationRoute.guards.Home(model.route)
              ? ["Commands"]
              : ["Connection status"],
            ariaLabel: "Main navigation",
            toHref: (item) =>
              item === "Commands"
                ? `${homeRouter()}#commands`
                : connectRouter(),
            isItemCurrent: (item) =>
              item === "Connection status" &&
              ApplicationRoute.guards.Connect(model.route),
            toView: ({ nav, items }) =>
              h.nav(
                [...nav, h.Class("flex items-center gap-[30px] text-[15px]")],
                Arr.map(items, (item) =>
                  h.a(
                    [
                      ...item.link,
                      h.Class(
                        cn(
                          "text-[15px] hover:text-foreground max-[620px]:text-sm",
                          item.isCurrent
                            ? "text-foreground underline underline-offset-4"
                            : "text-muted-foreground",
                        ),
                      ),
                    ],
                    [item.value],
                  ),
                ),
              ),
          }),
          themeSwitcher(model, h),
        ],
      ),
    ],
  );
