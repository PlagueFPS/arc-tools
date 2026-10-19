import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import { Config, Effect, Layer, Schema } from "effect";

const AccountId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/));
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
    const testAccountId = yield* Config.schema(
      AccountId,
      "TEST_CLOUDFLARE_ACCOUNT_ID",
    );
    const prodAccountId = yield* Config.schema(
      AccountId,
      "PROD_CLOUDFLARE_ACCOUNT_ID",
    );
    const prodApplicationId = yield* Config.schema(
      DiscordApplicationId,
      "PROD_DISCORD_APPLICATION_ID",
    );
    const { accountId: profileAccountId } =
      yield* yield* Cloudflare.CloudflareEnvironment;

    const testToken = yield* Cloudflare.ApiToken.AccountApiToken(
      "arc-tools-test-ci",
      {
        name: "arc-tools-test-ci",
        accountId: testAccountId,
        policies: [
          {
            effect: "allow",
            permissionGroups,
            resources: { [`com.cloudflare.api.account.${testAccountId}`]: "*" },
          },
        ],
      },
    );
    const prodToken = yield* Cloudflare.ApiToken.AccountApiToken(
      "arc-tools-prod-ci",
      {
        name: "arc-tools-prod-ci",
        accountId: prodAccountId,
        policies: [
          {
            effect: "allow",
            permissionGroups,
            resources: { [`com.cloudflare.api.account.${prodAccountId}`]: "*" },
          },
        ],
      },
    );

    yield* GitHub.Variable("test-account-id", {
      ...repository,
      name: "CLOUDFLARE_TEST_ACCOUNT_ID",
      value: testAccountId,
    });
    yield* GitHub.Secret("test-api-token", {
      ...repository,
      name: "CLOUDFLARE_TEST_API_TOKEN",
      value: testToken.value,
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
      value: prodAccountId,
    });
    yield* GitHub.Secret("prod-api-token", {
      ...repository,
      environment: prod,
      name: "CLOUDFLARE_API_TOKEN",
      value: prodToken.value,
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
      profileAccountId,
      testAccountId,
      prodAccountId,
      testTokenId: testToken.tokenId,
      prodTokenId: prodToken.tokenId,
    };
  }),
);
