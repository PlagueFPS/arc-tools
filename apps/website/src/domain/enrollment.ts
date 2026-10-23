import {
  EnrollmentFailure,
  EnrollmentStatus,
} from "@arctools/twitch/enrollment";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { useEffect, useState } from "react";

export class EnrollmentCheckError extends Error {
  constructor() {
    super("Status unavailable");
    this.name = "EnrollmentCheckError";
  }
}

async function checkEnrollment(
  signal: AbortSignal,
): Promise<EnrollmentStatus | null> {
  try {
    const response = await fetch("/oauth/twitch/enroll/status", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal,
    });

    if (response.status === 401) {
      return null;
    }

    if (response.status !== 200) {
      throw new EnrollmentCheckError();
    }

    const payload: unknown = await response.json();

    return Schema.decodeUnknownSync(EnrollmentStatus)(payload);
  } catch (error) {
    if (signal.aborted || error instanceof EnrollmentCheckError) {
      throw error;
    }

    throw new EnrollmentCheckError();
  }
}

export const enrollmentQuery = queryOptions<
  EnrollmentStatus | null,
  EnrollmentCheckError
>({
  queryKey: ["enrollment-status"],
  queryFn: ({ signal }) => checkEnrollment(signal),
  retry: false,
  staleTime: Infinity,
  gcTime: 0,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
});

export function useEnrollmentStatus() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return useQuery({ ...enrollmentQuery, enabled: mounted });
}

const failureGuidance: Readonly<Record<typeof EnrollmentFailure.Type, string>> =
  {
    "authorization-required":
      "The bot needs its channel authorization renewed. Ask the bot operator to check setup, then try connecting again.",
    "authorization-failed":
      "Twitch authorization could not be verified. Connect again and approve access for your broadcaster account.",
    denied:
      "Twitch access was declined. Connect again when you are ready to approve channel access.",
    expired:
      "This connection session has expired. Connect again to start a new session.",
    capacity:
      "The bot has reached its channel limit. Ask the bot operator about availability before trying again.",
    "repair-required":
      "Your channel connection needs attention from the bot operator. Ask them to check setup, then check your status again.",
    unavailable:
      "Channel enrollment is unavailable right now. Wait a moment and check again. If it continues, ask the bot operator to check setup.",
  };

export const guidance = (reason: typeof EnrollmentFailure.Type) =>
  failureGuidance[reason];

export const canReconnect = (reason: typeof EnrollmentFailure.Type) =>
  reason === "authorization-required" ||
  reason === "denied" ||
  reason === "expired" ||
  reason === "authorization-failed";
