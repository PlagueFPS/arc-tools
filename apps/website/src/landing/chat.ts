import { Button, Input } from "@foldkit/ui";
import { Array as Arr, type Record } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { type Author, type ChatLine, samples } from "./domain";
import { Message } from "./message";
import type { Model } from "./model";

const authorColor = {
  scrappy: "text-[#74dfbb]",
  luna_loots: "text-[#65b9ff]",
  moss: "text-[#c49bff]",
  raider_elle: "text-[#ffb17e]",
  You: "text-[#ffb17e]",
  ARCToolsBot: "text-[#f1c34b]",
} satisfies Record.ReadonlyRecord<typeof Author.Type, string>;

const chatLine = (line: ChatLine, h: HtmlBuilder<typeof Message.Type>): Html =>
  h.keyed("p")(
    `${line.id}`,
    [h.Class("mb-2.5 text-sm leading-[1.65] break-words last:mb-0")],
    [
      ...(line.author === "moss" || line.author === "ARCToolsBot"
        ? [
            h.span(
              [
                h.AriaLabel("Moderator"),
                h.Class(
                  "mr-1 inline-grid size-3.5 place-items-center rounded-[2px] bg-[#00875a] align-[1px] text-[11px] text-white",
                ),
              ],
              ["◆"],
            ),
          ]
        : []),
      h.strong([h.Class(authorColor[line.author])], [line.author]),
      h.span([], [": " + line.text]),
    ],
  );

export const chat = (model: Model, h: HtmlBuilder<typeof Message.Type>): Html =>
  h.section(
    [
      h.Id("chat-preview"),
      h.AriaLabel("Interactive Twitch chat preview"),
      h.Class(
        "overflow-hidden rounded-lg border border-[#39393e] bg-[#18181b] font-[Arial,sans-serif] text-[#efeff1] shadow-[10px_12px_0_#d8cebd] max-[620px]:shadow-[6px_8px_0_#d8cebd]",
      ),
    ],
    [
      h.div(
        [
          h.Class(
            "flex items-center justify-between border-b border-[#35353a] px-[18px] py-[17px] text-sm",
          ),
        ],
        [
          h.span([h.AriaHidden(true)], ["←"]),
          h.strong([h.Class("font-semibold")], ["Stream chat"]),
          h.svg(
            [
              h.ViewBox("0 0 20 20"),
              h.Class("size-[18px] fill-none stroke-[#d4d4d8] stroke-[1.5]"),
              h.AriaHidden(true),
            ],
            [
              h.circle([h.Cx("8"), h.Cy("6"), h.R("3")]),
              h.path([
                h.D("M2 17v-2a6 6 0 0 1 12 0v2M14 4a3 3 0 0 1 0 6m2 7v-2"),
              ]),
            ],
          ),
        ],
      ),
      h.div(
        [
          h.Id("chat-feed"),
          h.Role("log"),
          h.AriaLive("off"),
          h.AriaLabel("Sample stream conversation"),
          h.Tabindex(0),
          h.Class(
            "h-[280px] overflow-y-auto overscroll-contain px-4 pt-7 pb-6 [scrollbar-color:#55555f_#18181b] [scrollbar-width:thin] focus-visible:outline-2 focus-visible:-outline-offset-3 focus-visible:outline-[#bf94ff]",
          ),
        ],
        Arr.map(model.lines, (line) => chatLine(line, h)),
      ),
      h.form(
        [h.OnSubmit(Message.SubmittedChat()), h.Class("px-3 pb-3")],
        [
          h.div(
            [
              h.Class(
                "flex items-center gap-2.5 rounded-[5px] border border-[#6a6a73] bg-[#252529] px-3 focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-[#bf94ff]",
              ),
            ],
            [
              Input.view(
                {
                  id: "chat-message",
                  value: model.input,
                  onInput: (value) => Message.UpdatedChatInput({ value }),
                  placeholder: "Send a message",
                  toView: (attributes) =>
                    h.input([
                      ...attributes.input,
                      h.Name("message"),
                      h.AriaLabel("Try a chat command"),
                      h.Autocomplete("off"),
                      h.Maxlength(160),
                      h.OnFocus(Message.FocusedChatInput()),
                      h.OnBlur(Message.BlurredChatInput()),
                      h.Class(
                        "min-w-0 flex-1 border-0 bg-transparent py-[13px] text-[13px] text-[#efeff1] outline-none placeholder:text-[#adadb8]",
                      ),
                    ]),
                },
                h,
              ),
              h.span(
                [h.AriaHidden(true), h.Class("text-[22px] text-[#adadb8]")],
                ["☺"],
              ),
            ],
          ),
          h.div(
            [h.Class("flex items-center justify-between gap-3 pt-2.5")],
            [
              h.span([h.Class("text-xs text-[#adadb8]")], ["Sample chat"]),
              Button.view(
                {
                  type: "submit",
                  toView: (attributes) =>
                    h.button(
                      [
                        ...attributes.button,
                        h.Class(
                          "rounded bg-twitch px-[13px] py-2 text-[13px] font-semibold text-white hover:bg-twitch-hover",
                        ),
                      ],
                      ["Chat"],
                    ),
                },
                h,
              ),
            ],
          ),
        ],
      ),
      h.div(
        [
          h.Class(
            "flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-[#35353a] px-3.5 py-2 text-[13px] text-[#adadb8]",
          ),
        ],
        [
          h.span([], ["Try"]),
          ...Arr.map(samples, (sample) =>
            Button.view(
              {
                type: "button",
                onClick: Message.ClickedTryCommand({ text: sample.command }),
                toView: (attributes) =>
                  h.button(
                    [
                      ...attributes.button,
                      h.Class(
                        "min-h-11 bg-transparent py-2 text-[13px] text-[#d2b4ff] underline underline-offset-3 hover:text-white active:bg-white/10",
                      ),
                    ],
                    [sample.command],
                  ),
              },
              h,
            ),
          ),
        ],
      ),
    ],
  );
