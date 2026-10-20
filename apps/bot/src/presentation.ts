import { Schema } from "effect";

export const friendlyFailure =
  "I couldn't finish that command in time. Please try again.";

export const oversized =
  "That result is too long to send. Please try a more specific search.";

export const DiscordResponse = Schema.Struct({
  type: Schema.Literal(4),
  data: Schema.Struct({
    content: Schema.NonEmptyString.check(Schema.isMaxLength(2000)),
    flags: Schema.Literals([0, 64]),
    allowed_mentions: Schema.Struct({
      parse: Schema.Array(Schema.Never),
      replied_user: Schema.Literal(false),
    }),
  }),
});

export type DiscordResponse = typeof DiscordResponse.Type;

export const encodedBytes = (value: Schema.Json) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

export function discordResponse(text: string, failed = false): DiscordResponse {
  const tooLarge = text.length > 2000 || encodedBytes(text) > 7900;

  return {
    type: 4,
    data: {
      content: tooLarge ? oversized : text || friendlyFailure,
      flags: failed || tooLarge || !text ? 64 : 0,
      allowed_mentions: { parse: [], replied_user: false },
    },
  };
}

export function twitchParts(content: string): readonly string[] {
  const text = content.replaceAll("@", "@\u200b");

  if (text && text.length <= 495 && encodedBytes(text) <= 7000) return [text];
  const parts: string[] = [];
  let part = "";

  for (const point of text) {
    if (part.length + point.length > 489) {
      parts.push(part);
      part = "";
    }

    part += point;
  }

  if (part) parts.push(part);

  if (parts.length === 0) return [friendlyFailure];

  if (parts.length > 8) return [oversized];

  const labelled = parts.map((value, index) =>
    parts.length === 1 ? value : `[${index + 1}/${parts.length}]: ${value}`,
  );

  return encodedBytes(labelled) > 7000 ? [oversized] : labelled;
}
