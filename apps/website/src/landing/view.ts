import { Button } from "@foldkit/ui";
import { Array as Arr, Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { enrollmentPath } from "../route";
import { platformIcon } from "../view/icons";
import { chat } from "./chat";
import { LandingComposition } from "./composition";
import { Category, categoryLayout, visibleCommands } from "./domain";
import { Message } from "./message";
import type { Model } from "./model";

const filterKey = (category: Category, key: string) => {
  const index = Arr.findFirstIndex(
    Category.literals,
    (item) => item === category,
  ).pipe(Option.getOrElse(() => 0));

  const next =
    key === "Enter" || key === " "
      ? index
      : key === "ArrowRight"
        ? (index + 1) % 4
        : key === "ArrowLeft"
          ? (index + 3) % 4
          : key === "Home"
            ? 0
            : key === "End"
              ? 3
              : /^[1-4]$/.test(key)
                ? Number(key) - 1
                : -1;

  return Arr.get(Category.literals, next).pipe(
    Option.map((category) => ({
      focusSelector: `#category-${category}`,
      message: Message.SelectedCategory({ category, animate: false }),
    })),
  );
};

const categories = (
  model: Model,
  h: HtmlBuilder<typeof Message.Type>,
): Html => {
  const selected = categoryLayout[model.category];

  return h.div(
    [
      h.Role("group"),
      h.AriaLabel("Command category"),
      h.Class(
        "relative inline-flex items-center gap-0.5 rounded-full bg-[rgba(10,10,10,.82)] p-1 font-sans text-[13px] leading-none shadow-[0_0_0_1px_rgba(255,255,255,.08)_inset,0_2px_6px_rgba(0,0,0,.15)] backdrop-blur-[12px] backdrop-saturate-[1.4]",
      ),
    ],
    [
      h.span([
        h.AriaHidden(true),
        h.Class(
          `absolute top-1 left-0 h-7 rounded-full bg-white/12 ${model.animateCategory ? "transition-[transform,width] duration-250 ease-[cubic-bezier(.23,1,.32,1)] motion-reduce:transition-none" : "transition-none"}`,
        ),
        h.Style({
          width: `${selected.width}px`,
          transform: `translateX(${selected.left}px)`,
        }),
      ]),
      ...Arr.map(Category.literals, (category) =>
        Button.view(
          {
            type: "button",
            onClick: Message.SelectedCategory({ category, animate: true }),
            toView: (attributes) =>
              h.button(
                [
                  ...attributes.button,
                  h.Id(`category-${category}`),
                  h.AriaPressed(String(model.category === category)),
                  h.OnKeyDownFocus((key, modifiers) =>
                    modifiers.ctrlKey || modifiers.metaKey || modifiers.altKey
                      ? Option.none()
                      : filterKey(category, key),
                  ),
                  h.Style({ width: `${categoryLayout[category].width}px` }),
                  h.Class(
                    `relative flex h-7 items-center justify-center rounded-full bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/40 ${model.category === category ? "text-white" : "text-white/55 hover:text-white/85"}`,
                  ),
                ],
                [category],
              ),
          },
          h,
        ),
      ),
    ],
  );
};

const commands = (model: Model, h: HtmlBuilder<typeof Message.Type>): Html => {
  const visible = visibleCommands(model.category);

  return h.section(
    [
      h.Id("commands"),
      h.Tabindex(-1),
      h.Class("border-t border-border pt-[54px] max-[620px]:pt-[35px]"),
    ],
    [
      h.div(
        [
          h.Class(
            "mb-7 flex items-end justify-between gap-[30px] max-[620px]:flex-col max-[620px]:items-start max-[620px]:gap-3.5",
          ),
        ],
        [
          h.h2(
            [
              h.Class(
                "text-[clamp(32px,4vw,49px)] leading-[1.08] font-semibold tracking-[-.035em]",
              ),
            ],
            ["Commands"],
          ),
          h.p(
            [
              h.Class(
                "max-w-[350px] text-base leading-[1.6] text-muted-foreground",
              ),
            ],
            [
              "All 10 commands, ready for either chat. Pick an example to copy it.",
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("mb-7 flex flex-wrap items-center gap-2.5")],
        [categories(model, h)],
      ),
      h.p(
        [h.Role("status"), h.Class("mb-3.5 text-[13px] text-muted-foreground")],
        [`${visible.length} commands`],
      ),
      ...Arr.map(visible, (command) =>
        h.keyed("article")(
          command.name,
          [
            h.Class(
              "grid grid-cols-[minmax(150px,1.1fr)_minmax(0,2fr)] gap-[30px] border-t border-border py-6 max-[900px]:grid-cols-1 max-[900px]:gap-[15px]",
            ),
          ],
          [
            h.div(
              [],
              [
                h.h3(
                  [
                    h.Class(
                      "mb-[5px] text-[23px] font-semibold tracking-[-.02em]",
                    ),
                  ],
                  [command.name],
                ),
                h.p(
                  [
                    h.Class(
                      "max-w-[360px] text-[15px] leading-[1.6] text-muted-foreground",
                    ),
                  ],
                  [command.description],
                ),
              ],
            ),
            h.div(
              [h.Class("grid grid-cols-2 gap-3 max-[620px]:grid-cols-1")],
              Arr.map(["twitch", "discord"] as const, (platform) => {
                const example = command.example[platform];

                return h.div(
                  [h.Class("min-w-0")],
                  [
                    h.span(
                      [h.Class("mb-[7px] block text-xs text-muted-foreground")],
                      [platform === "twitch" ? "Twitch" : "Discord"],
                    ),
                    Button.view(
                      {
                        type: "button",
                        onClick: Message.ClickedCopyCommand({ text: example }),
                        toView: (attributes) =>
                          h.button(
                            [
                              ...attributes.button,
                              h.AriaLabel(
                                `Copy ${platform} example for ${command.name}`,
                              ),
                              h.Class(
                                "flex min-h-[47px] w-full items-center justify-between gap-3 rounded border border-border bg-transparent px-3.5 py-3 text-left active:bg-muted text-[15px]",
                              ),
                            ],
                            [
                              h.code(
                                [
                                  h.Class(
                                    "font-sans font-semibold break-words",
                                  ),
                                ],
                                [example],
                              ),
                              h.span(
                                [
                                  h.AriaHidden(true),
                                  h.Class("text-xs text-muted-foreground"),
                                ],
                                [
                                  Option.contains(model.copied, example)
                                    ? "Copied"
                                    : "Copy",
                                ],
                              ),
                            ],
                          ),
                      },
                      h,
                    ),
                  ],
                );
              }),
            ),
          ],
        ),
      ),
    ],
  );
};

export const view = LandingComposition.makeView((model, h) =>
  h.div(
    [
      h.Class(
        "mx-auto w-[min(1180px,calc(100%-80px))] pb-[48px] max-[900px]:w-[calc(100%-40px)]",
      ),
    ],
    [
      h.section(
        [
          h.Class(
            "grid grid-cols-[1.1fr_1fr] items-center gap-[70px] pt-[66px] pb-16 max-[900px]:grid-cols-1 max-[900px]:gap-9 max-[620px]:py-10",
          ),
        ],
        [
          h.div(
            [],
            [
              h.h1(
                [
                  h.Class(
                    "max-w-[680px] text-[clamp(50px,6.2vw,84px)] leading-[1.02] font-semibold tracking-[-.055em] max-[620px]:text-[clamp(46px,10vw,62px)]",
                  ),
                ],
                [
                  "The best ",
                  h.span([h.Class("whitespace-nowrap")], ["ARC Raiders"]),
                  " ",
                  h.span([h.Class("whitespace-nowrap")], ["chat bot."]),
                ],
              ),
              h.p(
                [
                  h.Class(
                    "mt-[26px] mb-[27px] max-w-[430px] text-[19px] leading-[1.6] max-[900px]:text-[17px]",
                  ),
                ],
                [
                  "Give your Twitch chat and Discord server instant answers on ARC drops, trader prices, crafting benches, recycle yields, and live Topside events.",
                ],
              ),
              h.div(
                [h.Class("flex flex-wrap gap-3 max-[900px]:gap-2")],
                Arr.map(["twitch", "discord"] as const, (platform) =>
                  h.a(
                    [
                      h.Href(
                        platform === "twitch"
                          ? enrollmentPath
                          : import.meta.env.VITE_DISCORD_INSTALL_URL,
                      ),
                      h.Class(
                        `motion-safe:[&:not(:focus-visible)]:transition-transform motion-safe:[&:not(:focus-visible)]:duration-[140ms] motion-safe:[&:not(:focus-visible)]:ease-[cubic-bezier(.23,1,.32,1)] motion-safe:[&:active:not(:focus-visible)]:scale-[.98] inline-flex min-h-[50px] items-center justify-center gap-2.5 rounded-[5px] border px-[21px] text-base font-semibold text-white max-[900px]:px-[15px] max-[900px]:text-[15px] ${platform === "twitch" ? "border-twitch bg-twitch hover:border-twitch-hover hover:bg-twitch-hover" : "border-discord bg-discord hover:border-discord-hover hover:bg-discord-hover"}`,
                      ),
                    ],
                    [
                      platformIcon(platform, h),
                      platform === "twitch"
                        ? "Add to Twitch"
                        : "Add to Discord",
                    ],
                  ),
                ),
              ),
              h.p(
                [
                  h.Class(
                    "mt-[15px] text-[13px] leading-[1.6] text-muted-foreground",
                  ),
                ],
                ["For your Twitch channel or Discord server."],
              ),
            ],
          ),
          chat(model, h),
        ],
      ),
      commands(model, h),
      h.p(
        [h.Role("status"), h.AriaLive("polite"), h.Class("sr-only")],
        [model.announcement],
      ),
    ],
  ),
);
