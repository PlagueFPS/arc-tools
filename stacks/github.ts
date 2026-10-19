import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import { Config, Effect, Layer, Schema } from "effect";

const DiscordApplicationId = Schema.String.check(
  Schema.isPattern(/^[0-9]{17,20}$/),
);
const repository = { owner: "PlagueFPS", repository: "arc-tools" };
const permissionGroups: Cloudflare.ApiToken.PermissionGroupRef[] = [
  "Workers Scripts Write",
  "Secrets Store Read",
  "Secrets Store Write",
];

export default Alchemy.Stack(
  "github",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const prodApplicationId = yield* Config.schema(
      DiscordApplicationId,
      "PROD_DISCORD_APPLICATION_ID",
    );
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;

    const token = yield* Cloudflare.ApiToken.AccountApiToken("arc-tools-ci", {
      name: "arc-tools-ci",
      accountId,
      policies: [
        {
          effect: "allow",
          permissionGroups,
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
      ],
    });

    yield* GitHub.Variable("test-account-id", {
      ...repository,
      name: "CLOUDFLARE_TEST_ACCOUNT_ID",
      value: accountId,
    });
    yield* GitHub.Secret("test-api-token", {
      ...repository,
      name: "CLOUDFLARE_TEST_API_TOKEN",
      value: token.value,
    });
    yield* GitHub.Variable("prod-discord-application-id", {
      ...repository,
      name: "PROD_DISCORD_APPLICATION_ID",
      value: prodApplicationId,
    });

    const prod = yield* GitHub.Environment("prod", {
      ...repository,
      name: "prod",
      deploymentBranchPolicy: { customBranchPolicies: ["main"] },
    });
    yield* GitHub.Variable("prod-account-id", {
      ...repository,
      environment: prod,
      name: "CLOUDFLARE_ACCOUNT_ID",
      value: accountId,
    });
    yield* GitHub.Secret("prod-api-token", {
      ...repository,
      environment: prod,
      name: "CLOUDFLARE_API_TOKEN",
      value: token.value,
    });
    yield* GitHub.Variable("prod-environment-discord-application-id", {
      ...repository,
      environment: prod,
      name: "DISCORD_APPLICATION_ID",
      value: prodApplicationId,
    });
    yield* GitHub.Variable("prod-arc-environment", {
      ...repository,
      environment: prod,
      name: "ARC_ENVIRONMENT",
      value: "production",
    });
    yield* GitHub.Variable("prod-twitch-sender-kind", {
      ...repository,
      environment: prod,
      name: "TWITCH_SENDER_KIND",
      value: "bot",
    });

    return {
      accountId,
      tokenId: token.tokenId,
    };
  }),
);
