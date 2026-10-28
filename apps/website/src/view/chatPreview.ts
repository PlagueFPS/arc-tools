import { String as Str } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Message } from "../message";

export function view(h: HtmlBuilder<Message>): Html {
  return h.section(
    [
      h.AriaLabel("Example Twitch chat"),
      h.Class(
        "max-w-[500px] rounded-xl border border-border bg-card shadow-lg tablet:max-w-none tablet:rotate-[1.5deg]",
      ),
    ],
    [
      h.div(
        [
          h.Class(
            "flex items-center gap-[9px] border-b border-border p-5 text-[10px] font-bold tracking-[1.5px]",
          ),
        ],
        [
          h.span([
            h.AriaHidden(true),
            h.Class("size-[6px] rounded-full bg-primary"),
          ]),
          "STREAM CHAT",
          h.span(
            [
              h.Class(
                "ml-auto rounded-sm border border-border px-[5px] py-[3px] text-[8px] text-muted-foreground",
              ),
            ],
            ["EXAMPLE"],
          ),
        ],
      ),
      h.div(
        [h.Class("px-[22px] pt-[25px] pb-[21px] tablet:pt-8 tablet:pb-[25px]")],
        [
          chatLine(
            {
              name: "raider_01",
              avatar: "bg-muted text-foreground",
              children: "anyone know where to find sensors?",
            },
            h,
          ),
          chatLine(
            {
              name: "luna",
              avatar: "bg-secondary text-secondary-foreground",
              children: "!find sensors",
            },
            h,
          ),
          h.div(
            [
              h.Class(
                "-mx-[6px] rounded-md border-l-2 border-primary bg-muted px-[13px] pt-4",
              ),
            ],
            [
              chatLine(
                {
                  name: "ARC Tools",
                  avatar: "bg-primary font-bold text-primary-foreground",
                  children:
                    "Item locations, crafting info, sell values. One command away.",
                },
                h,
              ),
            ],
          ),
          h.p(
            [h.Class("pt-[6px] text-center text-[10px] text-muted-foreground")],
            ["Ask in chat. Keep your eyes on the raid."],
          ),
        ],
      ),
      h.div(
        [
          h.AriaHidden(true),
          h.Class(
            "mx-[17px] mb-[18px] flex justify-between rounded border border-border px-3 py-[14px] text-[11px] text-muted-foreground",
          ),
        ],
        ["Send a message", h.span([], ["↵"])],
      ),
    ],
  );
}

function chatLine(
  {
    name,
    children,
    avatar,
  }: {
    name: string;
    children: string;
    avatar: string;
  },
  h: HtmlBuilder<Message>,
): Html {
  return h.div(
    [
      h.Class(
        "mb-[25px] flex gap-3 text-xs leading-[1.8] text-card-foreground",
      ),
    ],
    [
      h.span(
        [
          h.AriaHidden(true),
          h.Class(
            `size-7 shrink-0 rounded-md text-center text-xs leading-7 ${avatar}`,
          ),
        ],
        [Str.toUpperCase(Str.slice(0, 1)(name))],
      ),
      h.div(
        [],
        [
          h.p(
            [h.Class("mb-[3px] text-[11px] font-bold text-foreground")],
            [name],
          ),
          h.p([], [children]),
        ],
      ),
    ],
  );
}
