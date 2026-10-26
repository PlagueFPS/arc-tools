import { RuntimeContext } from "alchemy/RuntimeContext";
import { Effect, Exit, Semaphore } from "effect";

export const fixtureRuntime = RuntimeContext.of({
  Type: "test",
  id: "fixture-controls",
  env: {},
  get: () => Effect.succeed(undefined),
  set: (key) => Effect.succeed(key),
});

export const fixtureStorage = Effect.fnUntraced(function* () {
  const values = new Map<string, unknown>();
  const lock = yield* Semaphore.make(1);

  return {
    // SAFETY: The native storage API lets each caller choose its stored value type.
    get: <T = unknown>(key: string) =>
      Effect.sync(() => structuredClone(values.get(key)) as T | undefined),
    put: <T>(key: string, value: T) =>
      Effect.sync(() => {
        values.set(key, structuredClone(value));
      }),
    // SAFETY: Values keep the caller-owned storage types when listed.
    list: <T = unknown>({ prefix }: { prefix: string }) =>
      Effect.sync(
        () =>
          new Map([...values].filter(([key]) => key.startsWith(prefix))) as Map<
            string,
            T
          >,
      ),
    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const before = structuredClone(values);
        const exit = yield* Effect.exit(effect);

        if (Exit.isFailure(exit)) {
          values.clear();

          for (const [key, value] of before) values.set(key, value);

          return yield* Effect.failCause(exit.cause);
        }

        return exit.value;
      }).pipe(lock.withPermit),
  };
});
