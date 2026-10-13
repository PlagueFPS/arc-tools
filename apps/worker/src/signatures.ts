import { Effect, Schema } from "effect";

export class IngressError extends Schema.TaggedError<IngressError>()(
  "IngressError",
  { status: Schema.Number },
) {}
const Hex = Schema.String.check(Schema.isPattern(/^(?:[0-9a-fA-F]{2})+$/));
const encoder = new TextEncoder();
export const hexBytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
const signedBytes = (prefix: string, body: ArrayBuffer) => {
  const head = encoder.encode(prefix);
  const bytes = new Uint8Array(head.length + body.byteLength);
  bytes.set(head);
  bytes.set(new Uint8Array(body), head.length);
  return bytes;
};
export function isFresh(
  timestamp: number,
  maxAge: number,
  now = Date.now(),
): boolean {
  return (
    Number.isFinite(timestamp) &&
    timestamp >= now - maxAge &&
    timestamp <= now + 60000
  );
}
export const verifyTwitch = Effect.fnUntraced(function* (args: {
  id: string;
  timestamp: string;
  signature: string;
  body: ArrayBuffer;
  secret: string;
}) {
  if (
    !isFresh(Date.parse(args.timestamp), 600000) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(args.timestamp)
  )
    return yield* new IngressError({ status: 401 });
  const hex = args.signature.slice(7);
  if (
    !args.signature.startsWith("sha256=") ||
    hex.length !== 64 ||
    !Schema.is(Hex)(hex)
  )
    return yield* new IngressError({ status: 401 });
  const valid = yield* Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(args.secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      return crypto.subtle.verify(
        "HMAC",
        key,
        hexBytes(hex),
        signedBytes(args.id + args.timestamp, args.body),
      );
    },
    catch: () => new IngressError({ status: 401 }),
  });
  if (!valid) return yield* new IngressError({ status: 401 });
});
export const verifyDiscord = Effect.fnUntraced(function* (args: {
  timestamp: string;
  signature: string;
  body: ArrayBuffer;
  publicKey: string;
}) {
  if (
    !/^\d{1,12}$/.test(args.timestamp) ||
    !isFresh(Number(args.timestamp) * 1000, 300000) ||
    args.signature.length !== 128 ||
    !Schema.is(Hex)(args.signature)
  )
    return yield* new IngressError({ status: 401 });
  const valid = yield* Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        hexBytes(args.publicKey),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      return crypto.subtle.verify(
        "Ed25519",
        key,
        hexBytes(args.signature),
        signedBytes(args.timestamp, args.body),
      );
    },
    catch: () => new IngressError({ status: 401 }),
  });
  if (!valid) return yield* new IngressError({ status: 401 });
});
