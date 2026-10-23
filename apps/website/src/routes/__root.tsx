import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import { NotFound } from "../components/not-found";
import { SiteLayout } from "../components/site-layout";

import appCss from "../styles.css?url";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    head: () => ({
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { title: "ARC Tools · Your chat, raid ready." },
        { name: "theme-color", content: "#130918" },
        { name: "referrer", content: "no-referrer" },
        {
          name: "description",
          content:
            "ARC Raiders answers, right in Twitch chat. Connect your channel to ARC Tools for item, crafting, and event commands.",
        },
      ],
      links: [{ rel: "stylesheet", href: appCss }],
    }),
    component: App,
    notFoundComponent: NotFound,
    shellComponent: RootDocument,
  },
);

function App() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <SiteLayout>
        <Outlet />
      </SiteLayout>
    </QueryClientProvider>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
