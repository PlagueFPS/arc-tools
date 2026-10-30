import { Nav } from "@foldkit/ui";
import { Array as Arr } from "effect";
import type { Html } from "foldkit/html";

import type { ApplicationViewBuilder } from "../composition";
import { cn } from "../lib/utils";
import { ApplicationRoute, connectRouter, homeRouter } from "../route";
import { brandMark } from "./icons";
import { wrap } from "./shared";

export const view = (
  route: ApplicationRoute,
  h: ApplicationViewBuilder,
): Html =>
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
      Nav.view({
        items: ApplicationRoute.guards.Home(route)
          ? ["Commands"]
          : ["Connection status"],
        ariaLabel: "Main navigation",
        toHref: (item) =>
          item === "Commands" ? `${homeRouter()}#commands` : connectRouter(),
        isItemCurrent: (item) =>
          item === "Connection status" &&
          ApplicationRoute.guards.Connect(route),
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
    ],
  );
