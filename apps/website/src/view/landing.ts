import { Array as Arr } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { buttonVariants } from "../components/ui/button";
import type { Message } from "../message";
import { discordInstallPath } from "../route";
import { view as chatPreview } from "./chatPreview";
import { connectLink, eyebrow, wrap } from "./shared";

export const view = (h: HtmlBuilder<Message>): Html =>
  h.div([], [hero(h), details(h)]);

const hero = (h: HtmlBuilder<Message>): Html =>
  h.section(
    [
      h.Class(
        `${wrap} grid items-center gap-[45px] py-12 tablet:grid-cols-[1.15fr_1fr] tablet:gap-[35px] tablet:py-[70px] desktop:gap-[72px] desktop:pt-[98px] desktop:pb-[88px]`,
      ),
    ],
    [
      h.div(
        [],
        [
          eyebrow(
            {
              children: [
                h.span([
                  h.AriaHidden(true),
                  h.Class("size-[6px] rounded-full bg-primary"),
                ]),
                "BUILT FOR ARC RAIDERS · ON TWITCH & DISCORD",
              ],
            },
            h,
          ),
          h.h1(
            [
              h.Class(
                "my-[23px] font-heading text-[64px] leading-[1.05] font-semibold tracking-[-3px] tablet:text-[clamp(54px,6.2vw,86px)] desktop:tracking-[-5px] max-[380px]:text-[56px]",
              ),
            ],
            [
              "Your chat.",
              h.br([]),
              h.span([h.Class("text-foreground")], ["Raid ready."]),
            ],
          ),
          h.p(
            [
              h.Class(
                "max-w-[480px] text-base leading-[1.8] text-muted-foreground tablet:max-w-[430px]",
              ),
            ],
            [
              "Less alt-tabbing. More raiding. Give your community item, crafting, and event answers right in Twitch chat or your Discord server.",
            ],
          ),
          h.div(
            [h.Class("mt-[33px] flex flex-col items-start gap-[14px]")],
            [
              h.div(
                [h.Class("flex flex-wrap gap-3")],
                [
                  connectLink({}, h),
                  h.a(
                    [
                      h.Href(discordInstallPath),
                      h.Class(
                        buttonVariants({ variant: "outline", size: "lg" }),
                      ),
                    ],
                    ["Add to Discord", h.span([h.AriaHidden(true)], ["↗"])],
                  ),
                ],
              ),
              h.p(
                [
                  h.Class(
                    "text-[10px] leading-[1.7] text-muted-foreground tablet:text-[11px]",
                  ),
                ],
                [
                  "Connect your Twitch channel or add ARC Tools to your Discord server.",
                  h.br([]),
                  "No downloads. No chat overlay.",
                ],
              ),
            ],
          ),
          h.div(
            [
              h.Class(
                "mt-9 flex items-center gap-[13px] text-[10px] text-muted-foreground tablet:items-start desktop:items-center",
              ),
            ],
            [
              h.code(
                [h.Class("text-[11px] whitespace-nowrap text-foreground")],
                ["!find sensors"],
              ),
              h.span([], ["A little less searching. A lot more playing."]),
            ],
          ),
        ],
      ),
      chatPreview(h),
    ],
  );

const details = (h: HtmlBuilder<Message>): Html =>
  h.section(
    [
      h.AriaLabel("How ARC Tools works"),
      h.Class(
        `${wrap} border-t border-border pt-[35px] pb-[52px] tablet:pt-11`,
      ),
    ],
    [
      eyebrow({ children: "YOUR COMMUNITY'S FIELD GUIDE" }, h),
      h.h2(
        [h.Class("mt-2 font-heading text-[29px] tracking-[-1px]")],
        ["Good intel. Zero detours."],
      ),
      h.div(
        [
          h.Class(
            "mt-[35px] grid gap-[27px] tablet:grid-cols-3 tablet:gap-[25px] desktop:gap-[50px]",
          ),
        ],
        [
          capability(
            {
              number: "01 / CONNECT",
              title: "Your channel, connected.",
              children:
                "Authorize your broadcaster account with Twitch. We check the channel connection before calling it ready.",
            },
            h,
          ),
          capability(
            {
              number: "02 / ASK",
              title: "Let chat do the asking.",
              children:
                "Find items, check what to craft, or see what's happening topside. Viewers use simple chat commands.",
            },
            h,
          ),
          capability(
            {
              number: "03 / RAID",
              title: "Stay in the moment.",
              children:
                "Answers land in chat, where the conversation already is. You keep playing. Everyone keeps up.",
            },
            h,
          ),
        ],
      ),
      h.div(
        [
          h.Class(
            "mt-[35px] flex flex-wrap items-center gap-4 rounded-lg border border-border px-5 py-4 tablet:gap-[26px]",
          ),
        ],
        [
          h.span(
            [
              h.Class(
                "mr-auto w-full text-[9px] tracking-[1.5px] text-muted-foreground tablet:w-auto",
              ),
            ],
            ["IN YOUR CHAT"],
          ),
          ...Arr.map(
            ["!find sensors", "!craft sensors", "!active"],
            (command) =>
              h.code([h.Class("text-[11px] text-foreground")], [command]),
          ),
        ],
      ),
    ],
  );

function capability(
  {
    number,
    title,
    children,
  }: {
    number: string;
    title: string;
    children: string;
  },
  h: HtmlBuilder<Message>,
): Html {
  return h.article(
    [],
    [
      h.p(
        [
          h.Class(
            "text-[9px] font-bold tracking-[1.8px] text-muted-foreground",
          ),
        ],
        [number],
      ),
      h.h3(
        [
          h.Class(
            "my-2 font-heading text-[17px] font-medium tracking-[-0.4px] tablet:mt-[13px] tablet:mb-[10px]",
          ),
        ],
        [title],
      ),
      h.p(
        [
          h.Class(
            "text-xs leading-[1.9] text-muted-foreground tablet:max-w-[300px]",
          ),
        ],
        [children],
      ),
    ],
  );
}
