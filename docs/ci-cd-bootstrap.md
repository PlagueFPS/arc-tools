# Bootstrap GitHub deployment credentials

Use `stacks/github.ts` to provision Cloudflare credentials for `PlagueFPS/arc-tools` through Alchemy. This follows the credential bootstrap in [Alchemy tutorial part 5](https://alchemy.run/cloudflare/tutorial/part-5/). The repository pins Alchemy `2.0.0-beta.83`, Effect `4.0.4`, and Bun `1.3.5`.

Run these steps after code review. The stack creates credentials and GitHub configuration. It does not release either bot or change Discord or Twitch portal settings.

## Prepare the admin profile

Install the pinned dependencies from the repository root.

```bash
bun --no-env-file install --frozen-lockfile
```

Create a dedicated profile and connect its providers. The `--config` flag registers the GitHub provider from the bootstrap stack.

```bash
bunx --no-install alchemy profile create admin
bunx --no-install alchemy profile edit --config stacks/github.ts --profile admin --add Cloudflare
bunx --no-install alchemy profile edit --config stacks/github.ts --profile admin --add GitHub
```

If `admin` already exists, skip creation. To change an existing provider, replace `--add` with `--reconfigure`.

For Cloudflare, select API Token or API Key, not OAuth. The credential must have [Account API Tokens Write](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/) on both target accounts. It must also manage Workers and Secrets Store in the profile account for `Cloudflare.state()`. Keep token-management authority on this operator profile. Neither minted CI token receives that authority.

For GitHub, select `gh-cli` with an authenticated GitHub CLI session, or enter a personal access token privately. The GitHub identity needs access to `PlagueFPS/arc-tools` and rights to manage its Actions secrets, variables, environments, and deployment branch policies. A classic token needs `repo` scope. For a fine-grained token, grant repository write permissions for [Administration](https://docs.github.com/en/rest/deployments/environments#create-or-update-an-environment), [Secrets](https://docs.github.com/en/rest/actions/secrets#create-or-update-a-repository-secret), [Variables](https://docs.github.com/en/rest/actions/variables#create-a-repository-variable), and [Environments](https://docs.github.com/en/rest/actions/secrets#create-or-update-an-environment-secret). Enter credentials in the provider prompts, never in checked-in files or command arguments.

The profile account owns the bootstrap state for stack `github`, stage `admin`. The application stack remains `arc-tools`. The two stacks share an account state backend only when their accounts match. Select a profile account outside the test account to keep bootstrap state out of the test account's control.

## Set the required public inputs

Export both target account IDs and the existing production Discord application ID in your shell.

```bash
export TEST_CLOUDFLARE_ACCOUNT_ID='<32-character lowercase hexadecimal test account ID>'
export PROD_CLOUDFLARE_ACCOUNT_ID='<32-character lowercase hexadecimal production account ID>'
export PROD_DISCORD_APPLICATION_ID='<existing production Discord application ID>'
```

Both account inputs are required, even when they are equal. The stack validates their format and requires a 17-to-20-digit Discord application ID. The admin credential must have access to both target accounts if they differ. These inputs do not change the profile account used for bootstrap state.

Two tokens on the same account do not isolate Workers by name. A repository pull request with the test token's Workers Scripts Write permission can edit production Workers and the shared state backend on that account. Separate test and production accounts provide the stronger boundary. Keep the bootstrap profile account outside the test account when using that boundary.

## Provision the credentials

Run this command from the repository root. Use `--config` for the file and `--stage` for the stage.

```bash
bunx --no-install alchemy deploy --config stacks/github.ts --profile admin --stage admin --yes
```

Expect two distinct account-owned tokens, `arc-tools-test-ci` and `arc-tools-prod-ci`, even when the account IDs match. Each policy grants the following groups on `com.cloudflare.api.account.<its-account-id>: *`.

- `Workers Scripts Write` covers [Worker upload](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/) and removal. Cloudflare also accepts it for [account subdomain lookup](https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/get/) and [Durable Object namespace inspection](https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/methods/list/).
- `Secrets Store Read` permits [inspection of the state backend's Secrets Store](https://developers.cloudflare.com/api/resources/secrets_store/subresources/stores/methods/list/).
- `Secrets Store Write` permits creation and update of state backend secrets. The [Secrets Store create endpoint](https://developers.cloudflare.com/api/resources/secrets_store/subresources/stores/subresources/secrets/methods/create/) requires it.

The permission selection comes from the pinned `Cloudflare/Workers/WorkerProvider.ts`, `Cloudflare/StateStore/State.ts`, `Cloudflare/StateStore/Token.ts`, and `Cloudflare/SecretsStore` providers under `node_modules/alchemy/src`. The Worker provider uploads script settings and Durable Object bindings. The state provider adopts or creates its account Worker and ensures its bearer secret exists in Secrets Store. The cloud tests also list Durable Object namespaces.

These groups are the proposed minimum for this repository. Local typechecking and the API permission documentation do not prove a complete deployment succeeds. No remote bootstrap or cloud deployment was run to verify them. If an authorized run fails, inspect the failed endpoint before adding permissions. The stack grants no Account Settings groups or token-management groups to CI.

In GitHub, verify these repository names exist under **Settings > Secrets and variables > Actions**.

- Variable `CLOUDFLARE_TEST_ACCOUNT_ID` contains the test account ID.
- Secret `CLOUDFLARE_TEST_API_TOKEN` receives the test token directly.
- Variable `PROD_DISCORD_APPLICATION_ID` contains the production Discord application ID.

Under **Settings > Environments**, verify environment `prod` has a custom deployment branch policy allowing only `main`, with no required reviewers. Verify its configuration.

- Variable `CLOUDFLARE_ACCOUNT_ID` contains the production account ID.
- Secret `CLOUDFLARE_API_TOKEN` receives the distinct production token.
- Variable `DISCORD_APPLICATION_ID` matches repository variable `PROD_DISCORD_APPLICATION_ID`.
- Variable `ARC_ENVIRONMENT` is `production`.
- Variable `TWITCH_SENDER_KIND` is `bot`.

The environment is named `prod`. `production` is the value of `ARC_ENVIRONMENT`. The existing CI expressions for `vars.CLOUDFLARE_TEST_ACCOUNT_ID` and `secrets.CLOUDFLARE_TEST_API_TOKEN` receive their missing credentials after bootstrap. Fork pull requests do not receive repository secrets.

Alchemy passes each redacted token value directly to `GitHub.Secret`. Stack outputs contain only account IDs and token IDs. Alchemy persists the token value in state because Cloudflare reveals it only at creation. Treat access to the state backend and its authentication and encryption secrets as access to the stored tokens.

## Enter the existing production application configuration

Preserve both working bots, their current grants, and their callback registrations. Use the existing production Discord application and bot identity. Keep staging on its existing operator credentials.

Enter these application credentials privately in environment `prod` through the GitHub UI, or run each command and use its hidden prompt. Do not read or upload `.env.prod`.

```bash
gh secret set TWITCH_CLIENT_SECRET --repo PlagueFPS/arc-tools --env prod
gh secret set TWITCH_SIGNING_SECRET --repo PlagueFPS/arc-tools --env prod
gh secret set DISCORD_BOT_TOKEN --repo PlagueFPS/arc-tools --env prod
gh secret set OPERATOR_SECRET --repo PlagueFPS/arc-tools --env prod
```

Set these public variables manually in environment `prod`, using the current working production values.

- `TWITCH_SENDER_LOGIN` is the dedicated production bot login.
- `TWITCH_CHANNEL_LOGINS` contains comma-separated lowercase channel logins, such as `channel_one,channel_two`. Do not enter a JSON array.
- `TWITCH_CLIENT_ID` is the existing Twitch application client ID.
- `DISCORD_PUBLIC_KEY` is the existing production Discord application public key.
- `ARC_PUBLIC_URL` is the exact origin of the working production deployment.

Preserve the exact working `ARC_PUBLIC_URL`. The first production deployment failed at runtime until that URL was set and the release was rerun. A blank value is not a verified production configuration. Copy the existing origin from the operator's known working configuration, and confirm that it matches the deployed stack's `url` output. Do not derive a replacement from an account subdomain or change portal callbacks to accommodate this bootstrap.

After reviewing the workflow changes and completing these inputs, use the repository's release workflow to deploy. The bootstrap itself never triggers a workflow. A failed Discord sync after a successful Worker deployment needs a release rerun of that deployed revision, as described in the [operator guide](operator-guide.md).

## Rerun or recover the bootstrap

Keep stack `github`, stage `admin`, the same profile account, and the resource IDs stable. Normal reruns update the tracked policies and GitHub configuration without creating another token per run. A rerun does not rotate a token merely because it runs again.

A crash after Cloudflare creates a token but before Alchemy persists its state can leave an orphan. Before retrying a failed creation, inspect account-owned tokens through the Cloudflare dashboard. Compare their nonsecret IDs with the recorded stack state, and revoke only the untracked duplicate. Names alone cannot distinguish duplicates. Alchemy cannot recover an orphan's one-time token value.

Keep bootstrap state intact. Destroying this stack revokes its managed tokens and removes its managed GitHub resources. Do not use application test-stage cleanup against the bootstrap or its shared account state backend.

## Check local changes without deploying

Run these commands to check the bootstrap stack directly without invoking Alchemy or providers. To cover the stack in the root `check-types` task, include `stacks/**/*.ts` in the root `tsconfig.json`.

```bash
bun --no-env-file node_modules/typescript/bin/tsc --noEmit --skipLibCheck --strict --noUncheckedIndexedAccess --target ES2022 --module NodeNext --esModuleInterop --allowImportingTsExtensions --types bun stacks/github.ts
bun --no-env-file node_modules/@biomejs/biome/bin/biome check stacks/github.ts
```
