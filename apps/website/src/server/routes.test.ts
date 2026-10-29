import { Effect, Option } from "effect";
import { Server } from "foldkit/experimental";
import { expect, test, vi } from "vitest";

import { renderDocument, renderPage } from "../entry.server";
import { enrollmentResponse } from "./routes";

const responseFor = (request: Request) =>
  Server.handleRequest(request, {
    renderPage,
    renderDocument: (application) =>
      renderDocument(application, {
        entryScript: "/assets/test.js",
        stylesheets: ["/assets/test.css"],
        modulePreloads: [],
      }),
  });

test.each(["/", "/connect"])(
  "%s renders public content without reading browser enrollment",
  async (path) => {
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected network call"));

    try {
      const response = await responseFor(
        new Request(`https://site.invalid${path}`, {
          headers: { Cookie: "__Host-arctools-enrollment=private-fixture" },
        }),
      );

      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain(
        path === "/"
          ? "Your chat."
          : "Checking the connection session in this browser.",
      );
      expect(html).not.toContain("private-fixture");
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  },
);

test.each([
  "/install/discord",
  "/oauth/twitch/enroll",
  "/oauth/twitch/enroll/status",
  "/oauth/twitch/callback",
])("%s rejects HEAD and POST before starting enrollment", async (path) => {
  for (const method of ["HEAD", "POST"]) {
    const response = await responseFor(
      new Request(`https://site.invalid${path}`, { method }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(await response.text()).toBe("");
  }
});

test("status without the browser cookie returns a private 401", async () => {
  const response = await responseFor(
    new Request("https://site.invalid/oauth/twitch/enroll/status"),
  );

  expect(response.status).toBe(401);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: "enrollment-unavailable" });
});

test("unknown pages remain 404 and unsupported page methods are 405", async () => {
  expect(
    (await responseFor(new Request("https://site.invalid/missing"))).status,
  ).toBe(404);
  expect(
    (
      await responseFor(
        new Request("https://site.invalid/", { method: "POST" }),
      )
    ).status,
  ).toBe(405);
  expect(
    await Effect.runPromise(
      enrollmentResponse(
        new Request("https://site.invalid/oauth/twitch/unknown"),
      ),
    ),
  ).toEqual(Option.none());
});

test("native page-host negotiation does not advertise a JSON-only API", async () => {
  const response = await responseFor(
    new Request("https://site.invalid/oauth/twitch/enroll/status", {
      headers: { Accept: "application/json" },
    }),
  );

  expect(response.status).toBe(404);
  expect(response.headers.get("Vary")).toContain("Accept");
});

test("native Leave route enforces POST and rejects missing Origin before loading Bot", async () => {
  for (const method of ["GET", "HEAD", "PUT", "OPTIONS"]) {
    const response = await responseFor(
      new Request("https://site.invalid/oauth/twitch/enroll/leave", { method }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  }

  const response = await responseFor(
    new Request("https://site.invalid/oauth/twitch/enroll/leave", {
      method: "POST",
    }),
  );

  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("the page host dispatches the Discord install link using local configuration", async () => {
  vi.stubEnv("DISCORD_APPLICATION_ID", "123456789012345678");

  try {
    const response = await responseFor(
      new Request("https://site.invalid/install/discord"),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.searchParams.get("client_id")).toBe("123456789012345678");
    expect(location.searchParams.get("integration_type")).toBe("0");
  } finally {
    vi.unstubAllEnvs();
  }
});
