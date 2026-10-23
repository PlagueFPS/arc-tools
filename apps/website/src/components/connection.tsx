import type { EnrollmentStatus } from "@arctools/twitch/enrollment";
import { Link } from "@tanstack/react-router";

import {
  canReconnect,
  guidance,
  useEnrollmentStatus,
} from "../domain/enrollment";
import {
  ConnectLink,
  Eyebrow,
  button,
  contentPage,
  pageTitle,
} from "./controls";

export function Connection() {
  const query = useEnrollmentStatus();
  const absent = query.data === null && !query.isError;

  return (
    <section className={contentPage}>
      <Link to="/" className="text-xs text-[#bbb3c7] hover:text-violet">
        ← Back to ARC Tools
      </Link>
      <h1 className={pageTitle}>Your channel connection.</h1>
      <p className="text-sm leading-[1.8] text-muted">
        One place to see if your chat is ready for the next raid.
      </p>
      <div className="mt-[35px] rounded-lg border border-[#49414f] bg-[#211e27] p-[25px] tablet:p-[34px]">
        <div role="status" aria-live="polite" aria-atomic="true">
          {absent ? (
            <StatusHeading
              label="NO CONNECTION SESSION"
              title="Start with Twitch."
              copy="There is no connection session in this browser. Connect your channel, or return using the browser where you started."
            />
          ) : query.data ? (
            <EnrollmentDetails status={query.data} />
          ) : query.isError ? (
            <StatusHeading
              label="STATUS UNAVAILABLE"
              title="We couldn't check just now."
              copy="Your connection status could not be loaded. Check again in a moment. This does not mean your channel has disconnected."
            />
          ) : (
            <StatusHeading
              label="CHECKING CONNECTION"
              title="Getting your status…"
              copy="Checking the connection session in this browser."
            />
          )}
          {query.isError && query.data && !absent && (
            <p className="mt-5 text-[13px] leading-[1.8] text-[#e2ca9b]">
              Status could not be refreshed. The last known status is shown.
              Check again in a moment.
            </p>
          )}
        </div>
        <div className="mt-[26px] flex flex-wrap gap-[14px]">
          {(absent ||
            (!query.isFetching &&
              query.data?.kind === "failed" &&
              canReconnect(query.data.reason))) && <ConnectLink />}
          <button
            type="button"
            disabled={query.isPending || query.isFetching}
            onClick={() => {
              void query.refetch();
            }}
            className={`${button} border-[#56505e] bg-[#302c37] text-[#f2efe6] hover:bg-[#40364d]`}
          >
            {query.isPending || query.isFetching ? "Checking…" : "Check status"}
          </button>
        </div>
        <p className="mt-[18px] text-[11px] leading-[1.7] text-muted">
          Status belongs to this browser session. Check again after completing
          Twitch authorization.
        </p>
      </div>
    </section>
  );
}

function StatusHeading({
  label,
  title,
  copy,
}: {
  label: string;
  title: string;
  copy: string;
}) {
  return (
    <>
      <Eyebrow>{label}</Eyebrow>
      <h2 className="my-[14px] font-heading text-[28px] tracking-[-1px]">
        {title}
      </h2>
      <p className="max-w-[550px] text-sm leading-[1.9] text-muted">{copy}</p>
    </>
  );
}

function EnrollmentDetails({ status }: { status: EnrollmentStatus }) {
  switch (status.kind) {
    case "pending":
      return (
        <StatusHeading
          label="CONNECTION IN PROGRESS"
          title="Almost ready."
          copy="Your connection is still being verified. If Twitch authorization is open in another tab, finish there first. Then check your status again."
        />
      );
    case "ready":
      return (
        <>
          <StatusHeading
            label="CHANNEL CONNECTED"
            title="You're raid ready."
            copy={`ARC Tools is ready in ${status.login}'s Twitch chat.`}
          />
          <div className="mt-[25px] flex flex-wrap gap-[15px] rounded border border-[#514262] bg-[#2e263b] p-[18px]">
            <span className="self-center text-[9px] tracking-[1.2px]">
              TRY IT IN YOUR CHAT
            </span>
            <code className="text-sm text-[#d1c2fb]">!find sensors</code>
          </div>
        </>
      );
    case "failed":
      return (
        <StatusHeading
          label="CONNECTION NEEDS ATTENTION"
          title="Let's get you connected."
          copy={guidance(status.reason)}
        />
      );
  }
}
