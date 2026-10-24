import type { Html, HtmlBuilder } from "foldkit/html";

import { buttonSizes, buttonVariants } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { Message } from "../message";
import { enrollmentPath } from "../route";

export const wrap =
  "mx-auto w-[calc(100%-40px)] tablet:w-[calc(100%-56px)] desktop:w-[min(1184px,calc(100%-96px))]";

export const contentPage = cn(
  wrap,
  "min-h-[calc(100vh-195px)] max-w-[740px] py-[35px] pb-[55px] tablet:pt-[58px] tablet:pb-[85px]",
);

export const pageTitle =
  "mt-[35px] mb-[23px] font-heading text-[clamp(36px,5vw,50px)] font-semibold leading-[1.15] tracking-[-2px]";

export const primaryButton = cn(
  "inline-flex items-center justify-center gap-2 rounded-lg border border-transparent font-medium whitespace-nowrap transition-all",
  buttonVariants.default,
  buttonSizes.lg,
);

export const eyebrow = (
  { children }: { children: Html | string | ReadonlyArray<Html | string> },
  h: HtmlBuilder<Message>,
): Html =>
  h.p(
    [
      h.Class(
        "flex items-center gap-2 text-[10px] font-bold leading-[1.7] tracking-[1.8px] text-foreground",
      ),
    ],
    Array.isArray(children) ? children : [children],
  );

export const connectLink = (
  { className = "" }: { className?: string },
  h: HtmlBuilder<Message>,
): Html =>
  h.a(
    [h.Href(enrollmentPath), h.Class(cn(primaryButton, className))],
    ["Connect Twitch", h.span([h.AriaHidden(true)], ["↗"])],
  );
