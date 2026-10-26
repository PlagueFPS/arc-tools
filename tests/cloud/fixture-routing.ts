import { Context, Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

export const JourneyId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/),
).pipe(Schema.brand("FixtureJourney"));

export class CurrentJourney extends Context.Service<
  CurrentJourney,
  typeof JourneyId.Type
>()("fixture/Journey") {}

export const journeyUrl = (base: string, name: string) =>
  `${base}/journeys/${Schema.decodeUnknownSync(JourneyId)(name)}`;

export const accountJourney = (
  urls: { account: string; provider: string },
  name: string,
) => ({
  account: journeyUrl(urls.account, name),
  provider: journeyUrl(urls.provider, name),
});

export const cacheJourney = (
  urls: { cache: string; source: string },
  name: string,
) => ({
  url: journeyUrl(urls.cache, name),
  source: journeyUrl(urls.source, name),
});

export const parseJourney = (url: string) => {
  const match = /^\/journeys\/([a-z][a-z0-9-]{0,63})(\/[^#]*)$/.exec(url);

  if (!match) return null;

  return {
    id: Schema.decodeUnknownSync(JourneyId)(match[1]),
    url: match[2] ?? "/",
  };
};

export const routeJourney = <A, E, R>(handler: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const parsed = parseJourney(request.url);

    if (!parsed) return HttpServerResponse.empty({ status: 400 });

    return yield* handler.pipe(
      Effect.provideService(CurrentJourney, parsed.id),
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        request.modify({ url: parsed.url }),
      ),
    );
  });

export const journeyFromName = (name: string | undefined, prefix: string) => {
  if (!name?.startsWith(prefix))
    throw new Error("Fixture native journey identity unavailable");

  return Schema.decodeUnknownSync(JourneyId)(name.slice(prefix.length));
};
