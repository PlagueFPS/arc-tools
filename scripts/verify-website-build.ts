import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Schema } from "effect";

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

  assert.ok(html.includes(copy), `${path} has public content`);
  assert.ok(
    html.includes("data-foldkit-build="),
    `${path} carries a hydration identity`,
  );
  assert.ok(
    html.indexOf(copy) < html.indexOf('<script type="module"'),
    `${path} renders before JavaScript`,
  );
  assert.ok(
    !html.includes("/oauth/twitch/enroll/status"),
    `${path} contains no status request`,
  );
  assert.ok(
    !html.includes("__Host-arctools-enrollment"),
    `${path} contains no enrollment cookie`,
  );
  assert.match(html, /<link[^>]+href="\/assets\/[^" ]+\.css"/);
}

const assets = new URL("client/assets/", directory);

const files = await readdir(assets);

const styles = await Promise.all(
  files
    .filter((file) => file.endsWith(".css"))
    .map((file) => readFile(new URL(file, assets), "utf8")),
);

const scripts = await Promise.all(
  files
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFile(new URL(file, assets), "utf8")),
);

assert.ok(
  styles.some((style) => style.includes("Barlow")),
  "compiled CSS includes Barlow",
);

assert.ok(
  styles.some((style) => style.includes(".bg-background")),
  "compiled CSS contains Tailwind utilities",
);

assert.ok(
  files.some((file) => file.endsWith(".woff2")),
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
