import type { TwitchAccount, TwitchEnrollment } from "@arctools/twitch/server";
import type { Effect } from "effect";

type DomainOperations = {
  readonly enrollmentBegin: (typeof TwitchEnrollment.Service)["begin"];
  readonly enrollmentComplete: (typeof TwitchEnrollment.Service)["complete"];
  readonly enrollmentStatus: (typeof TwitchEnrollment.Service)["status"];
  readonly completeOperatorOAuth: (
    input: Omit<
      Parameters<(typeof TwitchAccount.Service)["completeOAuth"]>[0],
      "operator"
    >,
  ) => ReturnType<(typeof TwitchAccount.Service)["completeOAuth"]>;
};

export type BotOperations<R = never> = {
  readonly [K in keyof DomainOperations]: (
    ...args: Parameters<DomainOperations[K]>
  ) => Effect.Effect<
    Effect.Success<ReturnType<DomainOperations[K]>>,
    Effect.Error<ReturnType<DomainOperations[K]>>,
    R
  >;
};
