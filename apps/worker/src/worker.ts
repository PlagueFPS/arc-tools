import { commands } from "@arctools/commands";
import * as Cloudflare from "alchemy/Cloudflare";
import { ByteSize, Effect, Layer, Path, Schema, Stream } from "effect";
import {
  Etag,
  HttpPlatform,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/http-api";
import { ingressConfig, workerCompatibility } from "./config.ts";
import { DeliveryId, DiscordId, Token, TwitchId } from "./domain.ts";
import { DiscordGuild, TwitchChannel } from "./jobs.ts";
import { IngressError, verifyDiscord, verifyTwitch } from "./signatures.ts";

const Subscription = Schema.Struct({
  id: DeliveryId,
  type: Schema.Literal("channel.chat.message"),
  version: Schema.Literal("1"),
  condition: Schema.Struct({
    broadcaster_user_id: TwitchId,
    user_id: TwitchId,
  }),
  transport: Schema.Struct({
    method: Schema.Literal("webhook"),
    callback: Schema.String,
  }),
  status: Schema.String,
});
const Notification = Schema.Struct({
  subscription: Subscription,
  event: Schema.Struct({
    broadcaster_user_id: TwitchId,
    chatter_user_id: TwitchId,
    message_id: DeliveryId,
    message: Schema.Struct({ text: Schema.String }),
  }),
});
const Challenge = Schema.Struct({
  subscription: Subscription,
  challenge: Schema.NonEmptyString,
});
const Revocation = Schema.Struct({ subscription: Subscription });
const DiscordEnvelope = Schema.Struct({
  type: Schema.Number,
  application_id: DiscordId,
});
const Slash = Schema.Struct({
  type: Schema.Literal(2),
  application_id: DiscordId,
  id: DiscordId,
  token: Token,
  guild_id: Schema.optional(DiscordId),
  data: Schema.Struct({
    type: Schema.Literal(1),
    name: Schema.String,
    options: Schema.optional(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          type: Schema.Literal(3),
          value: Schema.String,
        }),
      ),
    ),
  }),
});
const TwitchHeaders = Schema.Struct({
  id: DeliveryId,
  timestamp: Schema.String,
  signature: Schema.String,
  type: Schema.Literals([
    "webhook_callback_verification",
    "notification",
    "revocation",
  ]),
  subscriptionType: Schema.Literal("channel.chat.message"),
  version: Schema.Literal("1"),
});
const Api = HttpApi.make("BotApi").add(
  HttpApiGroup.make("webhooks").add(
    HttpApiEndpoint.post("twitch", "/webhooks/twitch"),
    HttpApiEndpoint.post("discord", "/webhooks/discord"),
  ),
);
const decodeBody = <A, I>(schema: Schema.Codec<A, I>, raw: ArrayBuffer) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
    new TextDecoder().decode(raw),
  ).pipe(Effect.mapError(() => new IngressError({ status: 400 })));
const ephemeral = (content: string) =>
  HttpServerResponse.jsonUnsafe({
    type: 4,
    data: { content, flags: 64, allowed_mentions: { parse: [] } },
  });
const deferred = () =>
  HttpServerResponse.jsonUnsafe({
    type: 5,
    data: { allowed_mentions: { parse: [] } },
  });
const readBody = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const maxSize = yield* HttpServerRequest.MaxBodySize;
  const limit =
    maxSize === undefined ? 65536 : ByteSize.toNumberUnsafe(maxSize);
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit)
    return yield* new IngressError({ status: 413 });
  const initial: { size: number; chunks: Uint8Array[] } = {
    size: 0,
    chunks: [],
  };
  const body = yield* Stream.runFoldEffect(
    request.stream,
    () => initial,
    Effect.fnUntraced(function* (body, chunk) {
      if (body.size + chunk.byteLength > limit)
        return yield* new IngressError({ status: 413 });
      body.size += chunk.byteLength;
      body.chunks.push(chunk);
      return body;
    }),
  ).pipe(
    Effect.mapError((error) =>
      error instanceof IngressError ? error : new IngressError({ status: 400 }),
    ),
  );
  const bytes = new Uint8Array(body.size);
  let offset = 0;
  for (const chunk of body.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
});
const platform = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: HttpPlatform.makeCompressionWeb({
    algorithms: ["gzip", "deflate"],
    transform: (algorithm) => HttpPlatform.compressionTransformWeb(algorithm),
  }),
  fileResponse: () => Effect.die("Files are unavailable"),
  fileWebResponse: () => Effect.die("Files are unavailable"),
});

export default Cloudflare.Worker(
  "ArcBot",
  {
    main: import.meta.url,
    compatibility: workerCompatibility,
    build: { output: { codeSplitting: false } },
  },
  Effect.gen(function* () {
    const channels = yield* TwitchChannel;
    const guilds = yield* DiscordGuild;
    const config = yield* ingressConfig;
    const checkSubscription = Effect.fnUntraced(function* (
      subscription: typeof Subscription.Type,
    ) {
      if (
        subscription.condition.user_id !== config.twitchBotId ||
        !config.twitchChannels.includes(
          subscription.condition.broadcaster_user_id,
        )
      )
        return yield* new IngressError({ status: 403 });
    });
    const twitch = Effect.fnUntraced(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const raw = yield* readBody(request).pipe(
        Effect.provideService(
          HttpServerRequest.MaxBodySize,
          ByteSize.kibibytes(64),
        ),
      );
      const headers = yield* Schema.decodeUnknownEffect(TwitchHeaders)({
        id: request.headers["twitch-eventsub-message-id"],
        timestamp: request.headers["twitch-eventsub-message-timestamp"],
        signature: request.headers["twitch-eventsub-message-signature"],
        type: request.headers["twitch-eventsub-message-type"],
        subscriptionType: request.headers["twitch-eventsub-subscription-type"],
        version: request.headers["twitch-eventsub-subscription-version"],
      }).pipe(Effect.mapError(() => new IngressError({ status: 400 })));
      yield* verifyTwitch({
        ...headers,
        body: raw,
        secret: config.twitchSecret,
      });
      switch (headers.type) {
        case "webhook_callback_verification": {
          const body = yield* decodeBody(Challenge, raw);
          yield* checkSubscription(body.subscription);
          return HttpServerResponse.text(body.challenge);
        }
        case "revocation": {
          const body = yield* decodeBody(Revocation, raw);
          yield* checkSubscription(body.subscription);
          yield* Effect.logWarning("Twitch subscription revoked").pipe(
            Effect.annotateLogs({
              subscriptionId: body.subscription.id,
              broadcasterId: body.subscription.condition.broadcaster_user_id,
              status: body.subscription.status,
            }),
          );
          return HttpServerResponse.empty({ status: 204 });
        }
        case "notification": {
          const body = yield* decodeBody(Notification, raw);
          yield* checkSubscription(body.subscription);
          const event = body.event;
          if (
            event.broadcaster_user_id !==
            body.subscription.condition.broadcaster_user_id
          )
            return yield* new IngressError({ status: 403 });
          if (event.chatter_user_id === config.twitchBotId)
            return HttpServerResponse.empty({ status: 204 });
          const match = /^!(\S+)(?:\s+([\s\S]*))?$/.exec(
            event.message.text.trim(),
          );
          const command = commands.find(
            (command) => command.name === match?.[1]?.toLowerCase(),
          );
          if (command === undefined)
            return HttpServerResponse.empty({ status: 204 });
          yield* channels
            .getByName(event.broadcaster_user_id)
            .accept({
              kind: "twitch",
              deliveryId: headers.id,
              broadcasterId: event.broadcaster_user_id,
              messageId: event.message_id,
              command: command.name,
              input: (match?.[2] ?? "")
                .trim()
                .split(/\s+/)
                .filter(Boolean)
                .join(" "),
            })
            .pipe(Effect.mapError(() => new IngressError({ status: 503 })));
          return HttpServerResponse.empty({ status: 204 });
        }
      }
    });
    const discord = Effect.fnUntraced(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const raw = yield* readBody(request).pipe(
        Effect.provideService(
          HttpServerRequest.MaxBodySize,
          ByteSize.kibibytes(64),
        ),
      );
      yield* verifyDiscord({
        body: raw,
        timestamp: request.headers["x-signature-timestamp"] ?? "",
        signature: request.headers["x-signature-ed25519"] ?? "",
        publicKey: config.discordPublicKey,
      });
      const envelope = yield* decodeBody(DiscordEnvelope, raw);
      if (envelope.application_id !== config.discordApplicationId)
        return yield* new IngressError({ status: 403 });
      if (envelope.type === 1)
        return HttpServerResponse.jsonUnsafe({ type: 1 });
      if (envelope.type !== 2)
        return ephemeral("Only slash commands are supported.");
      const interaction = yield* decodeBody(Slash, raw);
      if (interaction.guild_id === undefined)
        return ephemeral("Commands are only available in a server.");
      const command = commands.find(
        (command) => command.name === interaction.data.name,
      );
      if (command === undefined) return ephemeral("Unknown command.");
      const options = interaction.data.options ?? [];
      if (
        new Set(options.map((option) => option.name)).size !== options.length ||
        options.some(
          (option) =>
            !command.slashOptions.some(
              (expected) => expected.name === option.name,
            ),
        ) ||
        command.slashOptions.some(
          (option) =>
            option.required !== false &&
            !options.some(
              (supplied) =>
                supplied.name === option.name &&
                supplied.value.trim().length > 0,
            ),
        )
      )
        return ephemeral("Please provide the required command options.");
      const input = command.slashOptions
        .map(
          (option) =>
            options
              .find((supplied) => supplied.name === option.name)
              ?.value.trim() ?? "",
        )
        .filter(Boolean)
        .join(" ");
      yield* guilds
        .getByName(interaction.guild_id)
        .accept({
          kind: "discord",
          guildId: interaction.guild_id,
          applicationId: interaction.application_id,
          interactionId: interaction.id,
          token: interaction.token,
          expiresAt:
            Number(request.headers["x-signature-timestamp"]) * 1000 +
            14 * 60_000,
          command: command.name,
          input,
        })
        .pipe(Effect.mapError(() => new IngressError({ status: 503 })));
      return deferred();
    });
    const handlers = HttpApiBuilder.group(Api, "webhooks", (handlers) =>
      handlers
        .handleRaw("twitch", () =>
          twitch().pipe(
            Effect.catchTag("IngressError", (error) =>
              Effect.succeed(
                HttpServerResponse.empty({ status: error.status }),
              ),
            ),
          ),
        )
        .handleRaw("discord", () =>
          discord().pipe(
            Effect.timeoutOrElse({
              duration: "2500 millis",
              orElse: () => new IngressError({ status: 503 }),
            }),
            Effect.catchTag("IngressError", (error) =>
              Effect.succeed(
                HttpServerResponse.empty({ status: error.status }),
              ),
            ),
          ),
        ),
    );
    return {
      fetch: yield* HttpRouter.toHttpEffect(
        HttpApiBuilder.layer(Api).pipe(
          Layer.provide(handlers),
          Layer.provide([Etag.layer, Path.layer, platform]),
        ),
      ),
    };
  }),
);
