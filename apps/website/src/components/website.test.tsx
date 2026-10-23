import { EnrollmentFailure } from "@arctools/twitch/enrollment";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { guidance } from "../domain/enrollment";
import { Connection } from "./connection";
import { Landing } from "./landing";
import { NotFound } from "./not-found";
import { SiteLayout } from "./site-layout";

describe("website rendering", () => {
  it("should render the public field guide without requesting private status", async () => {
    const fetchStatus = vi.fn();
    vi.stubGlobal("fetch", fetchStatus);
    await renderPage("/");

    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "Raid ready.",
    );
    expect(
      screen.getByRole("link", { name: /Connect Twitch/ }).getAttribute("href"),
    ).toBe("/oauth/twitch/enroll");
    expect(
      screen
        .getByRole("link", { name: "Skip to content" })
        .getAttribute("href"),
    ).toBe("#main");
    expect(screen.getByRole("main").getAttribute("tabindex")).toBe("-1");
    expect(
      screen.getByRole("navigation", { name: "Main navigation" }),
    ).toBeDefined();
    expect(
      screen.getByRole("link", { name: /Connection status/, current: false }),
    ).toBeDefined();
    expect(
      screen.getByRole("region", { name: "Example Twitch chat" }),
    ).toBeDefined();
    expect(screen.getByText("!craft sensors")).toBeDefined();
    expect(screen.getByText("!active")).toBeDefined();
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it("should render unknown paths as a 404 with home navigation", async () => {
    await renderPage("/lost");

    expect(
      screen.getByRole("heading", { name: "Nothing to loot here." }),
    ).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: "Back to ARC Tools" })
        .getAttribute("href"),
    ).toBe("/");
  });

  it("should render only the generic connection shell on the server", async () => {
    const fetchStatus = vi.fn();
    vi.stubGlobal("fetch", fetchStatus);
    const { router } = createTestRouter("/connect", true);
    await router.load();

    const html = renderToString(<RouterProvider router={router} />);

    expect(html).toContain("Your channel connection.");
    expect(html).toContain("Checking the connection session in this browser.");
    expect(html).not.toContain("You're raid ready.");
    expect(fetchStatus).not.toHaveBeenCalled();
  });
});

describe("channel enrollment", () => {
  it("should show pending without Connect and refresh manually to the named channel", async () => {
    const refresh = deferred<Response>();

    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ kind: "pending" }))
      .mockImplementationOnce(() => refresh.promise);

    vi.stubGlobal("fetch", fetchStatus);
    await renderPage("/connect");

    await screen.findByRole("heading", { name: "Almost ready." });
    expect(screen.queryByRole("link", { name: /Connect Twitch/ })).toBeNull();
    expect(
      screen.getByRole("link", { name: /Connection status/, current: "page" }),
    ).toBeDefined();
    const liveStatus = screen.getByRole("status");
    expect(liveStatus.getAttribute("aria-live")).toBe("polite");
    expect(liveStatus.getAttribute("aria-atomic")).toBe("true");
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(fetchStatus).toHaveBeenCalledWith(
      "/oauth/twitch/enroll/status",
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    expect(
      (await screen.findByRole("button", { name: "Checking…" })).hasAttribute(
        "disabled",
      ),
    ).toBe(true);
    expect(
      screen.getByRole("heading", { name: "Almost ready." }),
    ).toBeDefined();
    refresh.resolve(Response.json({ kind: "ready", login: "raider" }));

    await screen.findByText("ARC Tools is ready in raider's Twitch chat.");
    expect(screen.getByText("!find sensors")).toBeDefined();
    expect(screen.queryByRole("link", { name: /Connect Twitch/ })).toBeNull();
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("should offer enrollment when this browser has no session", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(null, { status: 401 })),
    );
    await renderPage("/connect");

    await screen.findByRole("heading", { name: "Start with Twitch." });
    expect(
      screen.getByRole("link", { name: /Connect Twitch/ }).getAttribute("href"),
    ).toBe("/oauth/twitch/enroll");
    expect(
      screen
        .getByRole("button", { name: "Check status" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it.each([
    {
      name: "HTTP unavailability",
      response: () => Promise.resolve(new Response(null, { status: 503 })),
    },
    {
      name: "network failure",
      response: () => Promise.reject(new Error("offline")),
    },
    {
      name: "invalid JSON",
      response: () => Promise.resolve(new Response("{invalid")),
    },
    {
      name: "invalid status",
      response: () =>
        Promise.resolve(Response.json({ kind: "ready", login: "" })),
    },
  ])(
    "should make $name recoverable through Check status",
    async ({ response }) => {
      const fetchStatus = vi
        .fn()
        .mockImplementationOnce(response)
        .mockResolvedValueOnce(Response.json({ kind: "pending" }));

      vi.stubGlobal("fetch", fetchStatus);
      await renderPage("/connect");

      await screen.findByRole("heading", {
        name: "We couldn't check just now.",
      });
      expect(screen.queryByRole("link", { name: /Connect Twitch/ })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Check status" }));

      await screen.findByRole("heading", { name: "Almost ready." });
      expect(fetchStatus).toHaveBeenCalledTimes(2);
    },
  );

  it.each(EnrollmentFailure.literals)(
    "should give actionable guidance for %s",
    async (reason) => {
      vi.stubGlobal("fetch", () =>
        Promise.resolve(Response.json({ kind: "failed", reason })),
      );
      await renderPage("/connect");

      await screen.findByText(guidance(reason));

      const recoverable = [
        "authorization-required",
        "authorization-failed",
        "denied",
        "expired",
      ].includes(reason);

      expect(
        screen.queryByRole("link", { name: /Connect Twitch/ }) !== null,
      ).toBe(recoverable);
      expect(
        screen.getByRole("button", { name: "Check status" }),
      ).toBeDefined();
    },
  );

  it("should label previously ready status as last known when refresh fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ kind: "ready", login: "raider" }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 503 })),
    );
    await renderPage("/connect");
    await screen.findByText("ARC Tools is ready in raider's Twitch chat.");

    fireEvent.click(screen.getByRole("button", { name: "Check status" }));

    await screen.findByText(/The last known status is shown/);
    expect(
      screen.getByText("ARC Tools is ready in raider's Twitch chat."),
    ).toBeDefined();
  });

  it("should discard previous ready state when a refresh finds no session", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ kind: "ready", login: "raider" }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 401 }))
        .mockResolvedValueOnce(new Response(null, { status: 503 })),
    );
    await renderPage("/connect");
    await screen.findByText("ARC Tools is ready in raider's Twitch chat.");

    fireEvent.click(screen.getByRole("button", { name: "Check status" }));

    await screen.findByRole("heading", { name: "Start with Twitch." });
    expect(
      screen.queryByText("ARC Tools is ready in raider's Twitch chat."),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    await screen.findByRole("heading", { name: "We couldn't check just now." });
    expect(
      screen.queryByText("ARC Tools is ready in raider's Twitch chat."),
    ).toBeNull();
  });

  it("should cancel on navigation and ignore a late response after reentry", async () => {
    const stale = deferred<Response>();
    const signal = deferred<AbortSignal>();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce((_url: string, options: RequestInit) => {
          if (options.signal) signal.resolve(options.signal);

          return stale.promise;
        })
        .mockResolvedValueOnce(
          Response.json({ kind: "ready", login: "new_channel" }),
        ),
    );
    const { router } = await renderPage("/connect");
    const requestSignal = await signal.promise;

    await act(() => router.navigate({ to: "/" }));
    await waitFor(() => expect(requestSignal.aborted).toBe(true));
    await act(() => router.navigate({ to: "/connect" }));
    await screen.findByText("ARC Tools is ready in new_channel's Twitch chat.");
    await act(async () => {
      stale.resolve(Response.json({ kind: "ready", login: "old_channel" }));
    });

    expect(
      screen.queryByText("ARC Tools is ready in old_channel's Twitch chat."),
    ).toBeNull();
    expect(
      screen.getByText("ARC Tools is ready in new_channel's Twitch chat."),
    ).toBeDefined();
  });

  it("should cancel an in-flight status request when unmounted", async () => {
    const signal = deferred<AbortSignal>();
    vi.stubGlobal("fetch", (_url: string, options: RequestInit) => {
      if (options.signal) signal.resolve(options.signal);

      return new Promise<Response>(() => {});
    });
    const page = await renderPage("/connect");
    const requestSignal = await signal.promise;

    page.unmount();

    expect(requestSignal.aborted).toBe(true);
  });
});

function createTestRouter(path: string, isServer = false) {
  const queryClient = new QueryClient();

  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <SiteLayout>
          <Outlet />
        </SiteLayout>
      </QueryClientProvider>
    ),
    notFoundComponent: NotFound,
  });

  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: Landing,
  });

  const connect = createRoute({
    getParentRoute: () => root,
    path: "/connect",
    component: Connection,
  });

  const router = createRouter({
    routeTree: root.addChildren([home, connect]),
    history: createMemoryHistory({ initialEntries: [path] }),
    isServer,
  });

  return { router, queryClient };
}

async function renderPage(path: string) {
  const { router, queryClient } = createTestRouter(path);
  await router.load();
  const page = render(<RouterProvider router={router} />);

  return { ...page, router, queryClient };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;

  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });

  return { promise, resolve };
}
