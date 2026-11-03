/* oxlint-disable effecttsgo/strict-effect-provide -- Tests own the browser command entry point. */
import { Deferred, Effect, Fiber, Layer, Option, Stream } from "effect";
import { Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";

import { ToggleTheme, RestoreTheme, ApplyTheme } from "../command";
import { BrowserStorageLayer } from "../layer";
import { Message } from "../message";
import { subscriptions } from "../subscription";
import { type Theme, themeColor, themeHead, themeStorageKey } from "../theme";

const runToggle = (theme: Theme = "dark") =>
  ToggleTheme({ theme }).effect.pipe(
    Effect.provide(
      ToggleTheme.layer.pipe(Layer.provideMerge(BrowserStorageLayer)),
    ),
    Effect.runPromise,
  );

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.classList.remove("light", "dark");
  localStorage.clear();
  document.head.innerHTML = "";
});

test.each([false, true])(
  "theme toggle persists both explicit choices (reverse=%s)",
  async (dark) => {
    document.head.innerHTML = themeHead;
    const stylesBefore = document.head.querySelectorAll("style").length;
    const chosen = dark ? "light" : "dark";
    const original = dark ? "dark" : "light";

    expect(await runToggle(chosen)).toEqual(Message.CompletedToggleTheme());
    expect(document.documentElement.classList.contains(chosen)).toBe(true);
    expect(localStorage.getItem(themeStorageKey)).toBe(JSON.stringify(chosen));

    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      expect(meta.getAttribute("content")).toBe(themeColor[chosen]);
    }

    expect(document.head.querySelectorAll("style")).toHaveLength(stylesBefore);

    await runToggle(original);
    expect(document.documentElement.classList.contains(original)).toBe(true);
    expect(document.documentElement.classList.contains(chosen)).toBe(false);
    expect(localStorage.getItem(themeStorageKey)).toBe(
      JSON.stringify(original),
    );
  },
);

test("theme switching works when storage is unavailable", async () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Storage denied", "SecurityError");
  });
  await runToggle();
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(document.head.querySelector("style")).toBeNull();
});

const runRestore = () =>
  RestoreTheme().effect.pipe(
    Effect.provide(
      RestoreTheme.layer.pipe(Layer.provideMerge(BrowserStorageLayer)),
    ),
    Effect.runPromise,
  );

test.each([
  { stored: '"light"', expected: "light" },
  { stored: '"dark"', expected: "dark" },
  { stored: '"invalid"', expected: "" },
  { stored: "dark", expected: "" },
  { stored: "{", expected: "" },
  { stored: "null", expected: "" },
  { stored: null, expected: "" },
])("restores only valid stored theme $stored", async ({ stored, expected }) => {
  if (stored !== null) localStorage.setItem(themeStorageKey, stored);
  document.head.innerHTML = themeHead;
  const restored = await runRestore();

  const expectedTheme: Option.Option<Theme> =
    expected === "light" || expected === "dark"
      ? Option.some(expected)
      : Option.none();

  expect(restored).toEqual(Message.RestoredTheme({ theme: expectedTheme }));

  if (Option.isSome(restored.theme)) {
    await ApplyTheme({ theme: restored.theme.value }).effect.pipe(
      Effect.provide(ApplyTheme.layer),
      Effect.runPromise,
    );
  }

  expect(document.documentElement.className).toBe(expected);

  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    const theme =
      expected === "light" || expected === "dark"
        ? expected
        : meta.getAttribute("data-theme");

    expect(meta.getAttribute("content")).toBe(
      theme === "dark" ? themeColor.dark : themeColor.light,
    );
  }
});

test("an unavailable storage read keeps the system theme", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("Storage denied", "SecurityError");
  });
  await runRestore();
  expect(document.documentElement.className).toBe("");
});

test("denied access to the storage object does not prevent theme switching", async () => {
  vi.spyOn(globalThis, "localStorage", "get").mockImplementation(() => {
    throw new DOMException("Storage denied", "SecurityError");
  });
  await runRestore();
  await runToggle();
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});

test("the system theme subscription emits immediately, follows changes, and cleans up", async () => {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  vi.spyOn(window, "matchMedia").mockReturnValue(media);
  const removeListener = vi.spyOn(media, "removeEventListener");
  const first = await Effect.runPromise(Deferred.make<void>());

  const fiber = Effect.runFork(
    subscriptions.systemTheme.dependenciesToStream({}).pipe(
      Stream.tap(() => Deferred.succeed(first, undefined)),
      Stream.take(3),
      Stream.runCollect,
      Effect.provide(subscriptions.layer),
    ),
  );

  try {
    await Effect.runPromise(Deferred.await(first));
    media.dispatchEvent(new MediaQueryListEvent("change", { matches: true }));
    media.dispatchEvent(new MediaQueryListEvent("change", { matches: false }));
    expect(await Effect.runPromise(Fiber.join(fiber))).toEqual([
      Message.ChangedSystemTheme({ theme: "light" }),
      Message.ChangedSystemTheme({ theme: "dark" }),
      Message.ChangedSystemTheme({ theme: "light" }),
    ]);
    expect(removeListener).toHaveBeenCalledWith("change", expect.any(Function));
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
});

test.each([
  { stored: '"light"', expected: "light" },
  { stored: '"dark"', expected: "dark" },
  { stored: '"invalid"', expected: "" },
  { stored: "{", expected: "" },
  { stored: null, expected: "" },
])(
  "pre-paint bootstrap applies only a valid override: $stored",
  async ({ stored, expected }) => {
    const browser = new Window({
      url: "https://bot.invalid/",
      settings: {
        enableJavaScriptEvaluation: true,
        // Only the application-owned bootstrap runs in this isolated test window.
        suppressInsecureJavaScriptEnvironmentWarning: true,
      },
    });

    try {
      if (stored !== null)
        browser.localStorage.setItem(themeStorageKey, stored);
      browser.document.write(
        `<!doctype html><html><head>${themeHead}</head><body></body></html>`,
      );
      expect(browser.document.documentElement.className).toBe(expected);

      for (const meta of browser.document.querySelectorAll(
        'meta[name="theme-color"]',
      )) {
        const selected = expected || meta.getAttribute("data-theme");
        expect(meta.getAttribute("content")).toBe(
          selected === "dark" ? themeColor.dark : themeColor.light,
        );
      }
    } finally {
      await browser.happyDOM.close();
    }
  },
);
