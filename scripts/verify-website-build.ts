/* oxlint-disable effecttsgo/node-builtin-import -- The host adapter uses Node filesystem, path, or process APIs before an Effect runtime is available. */
/* oxlint-disable effecttsgo/schema-sync -- The host adapter validates configuration and serializes native callbacks synchronously. */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Schema, Array as Arr, String as Str, Option } from "effect";

const directory = new URL("../apps/website/dist/", import.meta.url);

const manifest = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    client: Schema.String,
    server: Schema.String,
    serverEntry: Schema.String,
    prerendered: Schema.Array(Schema.String),
  }),
)(
  JSON.parse(
    await readFile(new URL("server/foldkit.build.json", directory), "utf8"),
  ),
);

assert.deepEqual(manifest.prerendered, ["/", "/connect"]);

assert.equal(manifest.serverEntry, "fetch.js");

for (const { path, copy } of [
  {
    path: "index.html",
    copy: "Give your Twitch chat and Discord server instant answers",
  },
  {
    path: "connect/index.html",
    copy: "Checking the connection session in this browser.",
  },
]) {
  const html = await readFile(new URL(`client/${path}`, directory), "utf8");

  if (path === "index.html") {
    const discordLink = Option.fromNullishOr(
      /<a[^>]+href="(https:\/\/discord\.com\/oauth2\/authorize\?[^" ]+)"[^>]*>[\s\S]*?Add to Discord/.exec(
        html,
      )?.[1],
    ).pipe(Option.getOrThrow);

    const install = new URL(Str.replace(/&amp;/g, "&")(discordLink));

    assert.match(install.searchParams.get("client_id") ?? "", /^[1-9][0-9]+$/);
    assert.equal(
      install.searchParams.get("scope"),
      "bot applications.commands",
    );
    assert.equal(install.searchParams.get("integration_type"), "0");
    assert.equal(install.searchParams.get("permissions"), "0");
    assert.ok(
      !Str.includes("/install/discord")(html),
      "Discord installs directly without a website endpoint",
    );
  }

  assert.ok(Str.includes(copy)(html), `${path} has public content`);
  assert.ok(
    Str.includes("data-foldkit-build=")(html),
    `${path} carries a hydration identity`,
  );
  assert.ok(
    Option.getOrElse(Str.indexOf(copy)(html), () => -1) <
      Option.getOrElse(Str.indexOf('<script type="module"')(html), () => -1),
    `${path} renders before JavaScript`,
  );
  assert.ok(
    !Str.includes("/oauth/twitch/enroll/status")(html),
    `${path} contains no status request`,
  );
  assert.ok(
    !Str.includes("__Host-arctools-enrollment")(html),
    `${path} contains no enrollment cookie`,
  );
  assert.match(html, /<link[^>]+href="\/assets\/[^" ]+\.css"/);
}

const assets = new URL("client/assets/", directory);

const files = await readdir(assets);

const styles = await Promise.all(
  Arr.map(
    Arr.filter(files, (file) => !!Str.endsWith(".css")(file)),
    (file) => readFile(new URL(file, assets), "utf8"),
  ),
);

const scripts = await Promise.all(
  Arr.map(
    Arr.filter(files, (file) => !!Str.endsWith(".js")(file)),
    (file) => readFile(new URL(file, assets), "utf8"),
  ),
);

assert.ok(
  Arr.some(styles, (style) => !!Str.includes("Barlow")(style)),
  "compiled CSS includes Barlow",
);

assert.ok(
  Arr.some(styles, (style) => !!Str.includes(".bg-background")(style)),
  "compiled CSS contains Tailwind utilities",
);

assert.ok(
  Arr.some(files, (file) => !!Str.endsWith(".woff2")(file)),
  "Barlow fonts are local assets",
);

assert.ok(scripts.length > 0, "a browser entry was emitted");

for (const script of scripts) {
  assert.doesNotMatch(
    script,
    /__Host-arctools-enrollment|ARC_OPERATOR_SECRET|cloudflare:workers/,
  );
}

process.stdout.write(
  `Verified two prerendered pages, native hydration, Tailwind, local fonts, and the browser/server boundary in ${fileURLToPath(directory)}\n`,
);
