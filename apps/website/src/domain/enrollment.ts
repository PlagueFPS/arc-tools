import {
  EnrollmentFailure,
  EnrollmentStatus,
} from "@arctools/twitch/enrollment";
import { Schema } from "effect";
import { AsyncData } from "foldkit";
import { defineTaggedUnion } from "foldkit/schema";

export { EnrollmentStatus };

export const RequestId = Schema.Int.pipe(Schema.brand("EnrollmentRequestId"));

export const CheckError = defineTaggedUnion({
  Absent: {},
  Unavailable: {},
});

export type CheckError = typeof CheckError.Type;

export const Enrollment = AsyncData.Schema(EnrollmentStatus, CheckError);

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

export const canLeaveChannel = (status: EnrollmentStatus) =>
  status.kind === "ready" ||
  status.kind === "recovering" ||
  status.kind === "attention-required";

const attentionGuidance: Readonly<
  Record<
    Extract<EnrollmentStatus, { kind: "attention-required" }>["reason"],
    string
  >
> = {
  "sender-authorization-required":
    "The bot's Twitch authorization needs to be renewed by its operator. Automatic reconnect cannot finish until that access is restored.",
  "broadcaster-authorization-required":
    "Your channel's Twitch authorization needs to be renewed. Connect again to approve access, or leave your channel below.",
  "ingress-required":
    "The bot's Twitch callback needs attention from its operator. Automatic reconnect cannot finish until setup is restored.",
  "setup-required":
    "The bot's setup needs attention from its operator. Your channel remains installed, and you can still leave below.",
};

export const attentionMessage = (
  reason: Extract<EnrollmentStatus, { kind: "attention-required" }>["reason"],
) => attentionGuidance[reason];
