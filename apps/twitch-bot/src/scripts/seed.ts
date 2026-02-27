import { BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { ChannelRepository } from "@/services/channel-repository";
import { TwurpleAuthService } from "@/services/twurple-auth";

const SeedLayer = Layer.mergeAll(
  TwurpleAuthService.Default,
  ChannelRepository.Default,
);

const seed = Effect.gen(function* () {
  const { botUserId } = yield* TwurpleAuthService;
  const channelRepository = yield* ChannelRepository;

  yield* channelRepository.upsertChannel({
    broadcasterId: botUserId,
    broadcasterLogin: "arctoolsbot",
  });

  yield* Effect.log("Seeded channel");
}).pipe(Effect.provide(SeedLayer));

BunRuntime.runMain(seed);
