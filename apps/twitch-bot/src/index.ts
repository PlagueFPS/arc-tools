import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";
import { TwitchBotService } from "./services/twitch-bot";

const startTwitchBot = Effect.gen(function* () {
  const { run } = yield* TwitchBotService;
  yield* run;
}).pipe(Effect.provide(TwitchBotService.Default));

BunRuntime.runMain(startTwitchBot);
