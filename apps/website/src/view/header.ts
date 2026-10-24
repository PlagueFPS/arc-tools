import { Nav } from "@foldkit/ui";
import type { Html, HtmlBuilder } from "foldkit/html";

import { cn } from "../lib/utils";
import type { Message } from "../message";
import { ApplicationRoute, connectRouter, homeRouter } from "../route";
import { wrap } from "./shared";

export const view = (route: ApplicationRoute, h: HtmlBuilder<Message>): Html =>
  h.header(
    [
      h.Class(
        cn(
          wrap,
          "flex items-center justify-between border-b border-border py-[22px] tablet:py-8",
        ),
      ),
    ],
    [
      h.a(
        [
          h.Href(homeRouter()),
          h.AriaLabel("ARC Tools home"),
          h.Class(
            "flex items-center gap-2 font-heading text-[17px] font-bold tracking-[-0.6px] tablet:text-[21px] max-[380px]:gap-[5px]",
          ),
        ],
        [
          h.span(
            [
              h.AriaHidden(true),
              h.Class(
                "mr-[5px] grid h-[29px] w-[26px] -skew-x-[9deg] place-items-center bg-primary text-[26px] text-primary-foreground tablet:h-[33px] tablet:w-[31px]",
              ),
            ],
            ["A"],
          ),
          "ARC",
          h.span([h.Class("font-normal text-muted-foreground")], ["TOOLS"]),
        ],
      ),
      Nav.view({
        items: ["Connection status"],
        ariaLabel: "Main navigation",
        toHref: () => connectRouter(),
        isItemCurrent: () => ApplicationRoute.guards.Connect(route),
        toView: ({ nav, items }) =>
          h.nav(
            nav,
            items.map((item) =>
              h.a(
                [
                  ...item.link,
                  h.Class(
                    cn(
                      "flex items-center gap-2 text-[11px] hover:text-foreground tablet:gap-[21px] tablet:text-[13px]",
                      item.isCurrent
                        ? "text-foreground underline underline-offset-4"
                        : "text-muted-foreground",
                    ),
                  ),
                ],
                [
                  item.value,
                  h.span(
                    [h.AriaHidden(true), h.Class("max-[380px]:hidden")],
                    ["↗"],
                  ),
                ],
              ),
            ),
          ),
      }),
    ],
  );
