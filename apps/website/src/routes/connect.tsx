import { createFileRoute } from "@tanstack/react-router";

import { Connection } from "../components/connection";

export const Route = createFileRoute("/connect")({
  head: () => ({ meta: [{ title: "Connection status · ARC Tools" }] }),
  component: Connection,
});
