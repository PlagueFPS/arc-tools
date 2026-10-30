import { ApplicationComposition, LandingBinding } from "./composition";
import { ApplicationRoute } from "./route";
import { view as connection } from "./view/connection";
import { view as header } from "./view/header";
import { brandMark } from "./view/icons";
import { view as notFound } from "./view/notFound";
import { wrap } from "./view/shared";

export const view = ApplicationComposition.makeView((model, h) => ({
  title: ApplicationRoute.match(model.route, {
    Home: () => "ARCToolsBot · ARC Raiders chat bot",
    Connect: () => "Connection status · ARCToolsBot",
    NotFound: () => "Page not found · ARCToolsBot",
  }),
  body: h.div(
    [h.Class("min-h-screen bg-background pb-[110px]")],
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
            Home: () =>
              h.block(
                LandingBinding.embedView({
                  slotId: "landing",
                  model: model.landing,
                }),
              ),
            Connect: () => connection(model, h),
            NotFound: () => notFound(h),
          }),
        ],
      ),
      h.footer(
        [
          h.Class(
            `${wrap} flex justify-between gap-6 border-t border-border pt-[25px] text-[13px] text-muted-foreground max-[620px]:flex-col max-[620px]:gap-2`,
          ),
        ],
        [
          h.span(
            [h.Class("flex items-center gap-1.5")],
            [
              brandMark(h, "size-[18px]"),
              "ARCToolsBot · Powered by the Metaforge ARC Raiders API",
            ],
          ),
          h.span(
            [],
            ["Community project. Not affiliated with Embark Studios."],
          ),
        ],
      ),
    ],
  ),
}));
