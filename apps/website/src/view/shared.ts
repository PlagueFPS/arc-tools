import { Array as Arr } from "effect";
import type { Html } from "foldkit/html";

import { buttonVariants } from "../components/ui/button";
import type { ApplicationViewBuilder } from "../composition";
import { cn } from "../lib/utils";
import { enrollmentPath } from "../route";

export const wrap =
  "mx-auto w-[min(1180px,calc(100%-80px))] max-[900px]:w-[calc(100%-40px)]";

export const contentPage = cn(
  wrap,
  "min-h-[calc(100vh-195px)] max-w-[740px] py-[35px] pb-[55px] tablet:pt-[58px] tablet:pb-[85px]",
);

export const pageTitle =
  "mt-[35px] mb-[23px] font-heading text-[clamp(36px,5vw,50px)] font-semibold leading-[1.15] tracking-[-2px]";

export const primaryButton = buttonVariants({ size: "lg" });

export const eyebrow = (
  { children }: { children: Html | string | ReadonlyArray<Html | string> },
  h: ApplicationViewBuilder,
): Html =>
  h.p(
    [
      h.Class(
        "flex items-center gap-2 text-[10px] font-bold leading-[1.7] tracking-[1.8px] text-foreground",
      ),
    ],
    Arr.isArray<typeof children>(children) ? children : [children],
  );

export const connectLink = (
  { className = "" }: { className?: string },
  h: ApplicationViewBuilder,
): Html =>
  h.a(
    [h.Href(enrollmentPath), h.Class(cn(primaryButton, className))],
    ["Connect Twitch", h.span([h.AriaHidden(true)], ["↗"])],
  );
