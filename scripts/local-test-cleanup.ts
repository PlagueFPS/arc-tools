import { readFile, rm } from "node:fs/promises";
import { connect } from "node:net";

import { Schema } from "effect";

import { LocalTestResources } from "./local-test-settings.js";

export async function cleanupLocalTest(directory: URL, stage: string) {
  const resourceFile = Bun.file(new URL("resources.json", directory));

  if (await resourceFile.exists()) {
    const resources = Schema.decodeUnknownSync(LocalTestResources)(
      JSON.parse(await readFile(new URL("resources.json", directory), "utf8")),
    );

    if (resources.stage !== stage)
      throw new Error("Local resource journal stage mismatch");

    for (const origin of resources.origins) {
      const url = new URL(origin);
      await new Promise<void>((resolve, reject) => {
        const socket = connect({ host: url.hostname, port: Number(url.port) });
        socket.once("connect", () => {
          socket.destroy();
          reject(
            new Error(`Local test listener is still running at ${origin}`),
          );
        });
        socket.once("error", (error) => {
          socket.destroy();

          if (
            Schema.is(Schema.Struct({ code: Schema.Literal("ECONNREFUSED") }))(
              error,
            )
          )
            resolve();
          else reject(error);
        });
        socket.setTimeout(2000, () => {
          socket.destroy();
          reject(new Error(`Could not verify that ${origin} stopped`));
        });
      });
    }
  }

  await rm(new URL(".alchemy/", directory), { recursive: true, force: true });
}
