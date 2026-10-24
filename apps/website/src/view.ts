import { ApplicationComposition } from "./composition";
import { cn } from "./lib/utils";
import { ApplicationRoute } from "./route";
import { view as connection } from "./view/connection";
import { view as header } from "./view/header";
import { view as landing } from "./view/landing";
import { view as notFound } from "./view/notFound";
import { wrap } from "./view/shared";

export const view = ApplicationComposition.makeView((model, h) => ({
  title: ApplicationRoute.match(model.route, {
    Home: () => "ARC Tools · Your chat, raid ready.",
    Connect: () => "Connection status · ARC Tools",
    NotFound: () => "Page not found · ARC Tools",
  }),
  body: h.div(
    [h.Class("min-h-screen bg-background")],
    [
      h.a(
        [
          h.Href("#main"),
          h.Class(
            "absolute -top-[100px] left-5 z-10 bg-primary p-3 text-primary-foreground focus:top-[15px]",
          ),
        ],
        ["Skip to content"],
      ),
      header(model.route, h),
      h.main(
        [h.Id("main"), h.Tabindex(-1)],
        [
          ApplicationRoute.match(model.route, {
            Home: () => landing(h),
            Connect: () => connection(model, h),
            NotFound: () => notFound(h),
          }),
        ],
      ),
      h.footer(
        [
          h.Class(
            cn(
              wrap,
              "flex flex-wrap items-center gap-[14px] border-t border-border py-[25px] text-[11px] text-muted-foreground tablet:gap-[25px] desktop:justify-between",
            ),
          ),
        ],
        [
          h.span(
            [
              h.Class(
                "font-heading text-xs font-semibold tracking-[1px] text-foreground",
              ),
            ],
            ["ARC TOOLS"],
          ),
          h.p([], ["Made for the raid. Built for your community."]),
          h.p(
            [h.Class("w-full text-[9px] leading-[1.7] tablet:w-auto")],
            [
              "An independent community tool. Not affiliated with Embark Studios or Twitch.",
            ],
          ),
        ],
      ),
    ],
  ),
}));
