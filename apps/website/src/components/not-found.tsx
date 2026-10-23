import { Link } from "@tanstack/react-router";

import { Eyebrow, contentPage, pageTitle, primaryButton } from "./controls";

export function NotFound() {
  return (
    <section className={contentPage}>
      <title>Page not found · ARC Tools</title>
      <Eyebrow>404 / OFF THE MAP</Eyebrow>
      <h1 className={pageTitle}>Nothing to loot here.</h1>
      <p className="mb-6 text-muted-foreground">
        This page could not be found.
      </p>
      <Link to="/" className={primaryButton}>
        Back to ARC Tools
      </Link>
    </section>
  );
}
