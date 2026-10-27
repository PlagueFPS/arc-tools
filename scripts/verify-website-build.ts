/* oxlint-disable effecttsgo/node-builtin-import -- The host adapter uses Node filesystem, path, or process APIs before an Effect runtime is available. */
/* oxlint-disable effecttsgo/schema-sync -- The host adapter validates configuration and serializes native callbacks synchronously. */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  Schema,
  Array as EffectArray,
  String as EffectString,
  Option as EffectOption,
} from "effect";

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
  { path: "index.html", copy: "Your chat." },
  {
    path: "connect/index.html",
    copy: "Checking the connection session in this browser.",
  },
]) {
  const html = await readFile(new URL(`client/${path}`, directory), "utf8");

  if (path === "index.html") {
    assert.match(html, /<a[^>]+href="\/install\/discord"[^>]*>Add to Discord/);
  }

  assert.ok(EffectString.includes(copy)(html), `${path} has public content`);
  assert.ok(
    EffectString.includes("data-foldkit-build=")(html),
    `${path} carries a hydration identity`,
  );
  assert.ok(
    EffectOption.getOrElse(EffectString.indexOf(copy)(html), () => -1) <
      EffectOption.getOrElse(
        EffectString.indexOf('<script type="module"')(html),
        () => -1,
      ),
    `${path} renders before JavaScript`,
  );
  assert.ok(
    !EffectString.includes("/oauth/twitch/enroll/status")(html),
    `${path} contains no status request`,
  );
  assert.ok(
    !EffectString.includes("__Host-arctools-enrollment")(html),
    `${path} contains no enrollment cookie`,
  );
  assert.match(html, /<link[^>]+href="\/assets\/[^" ]+\.css"/);
}

const assets = new URL("client/assets/", directory);

const files = await readdir(assets);

const styles = await Promise.all(
  EffectArray.map(
    EffectArray.filter(files, (file) => !!EffectString.endsWith(".css")(file)),
    (file) => readFile(new URL(file, assets), "utf8"),
  ),
);

const scripts = await Promise.all(
  EffectArray.map(
    EffectArray.filter(files, (file) => !!EffectString.endsWith(".js")(file)),
    (file) => readFile(new URL(file, assets), "utf8"),
  ),
);

assert.ok(
  EffectArray.some(styles, (style) => !!EffectString.includes("Barlow")(style)),
  "compiled CSS includes Barlow",
);

assert.ok(
  EffectArray.some(
    styles,
    (style) => !!EffectString.includes(".bg-background")(style),
  ),
  "compiled CSS contains Tailwind utilities",
);

assert.ok(
  EffectArray.some(files, (file) => !!EffectString.endsWith(".woff2")(file)),
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
