import { Effect, Layer } from "effect";
import { Digest, Mac, SecureRandom, Signature } from "effect/crypto";
import { Hex } from "effect/encoding";

export const cryptoLayer = Layer.mergeAll(
  Digest.layerWebCrypto,
  SecureRandom.layerWebCrypto,
  Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto)),
  Signature.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto)),
);

export const randomUUID = Effect.flatMap(SecureRandom.SecureRandom, (random) =>
  random.uuidV4(),
);

export const randomCredential = Effect.flatMap(
  SecureRandom.SecureRandom,
  (random) => random.randomBytes(32).pipe(Effect.map(Hex.encode)),
);

export const digest = (value: string) =>
  Effect.flatMap(Digest.Digest, (digest) =>
    digest.digestHex(Digest.sha256, new TextEncoder().encode(value)),
  );
