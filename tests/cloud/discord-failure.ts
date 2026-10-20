import { expect } from "bun:test";

import {
  discordResponse,
  friendlyFailure,
} from "../../apps/bot/src/presentation.js";

export type DataFailureScenario = "slow" | "missing" | "malformed";

export type DiscordFailureObservation = {
  reply: unknown;
  tenantPhase: string | null;
  tenantCode: string | null;
  fallback: string | null;
  fallbackCode: string | null;
};

const sourceError = {
  tenantCode: "command-error",
  reply: discordResponse(
    "Game data is temporarily unavailable. Please try again shortly.",
    true,
  ),
};

const tenantTimeout = {
  tenantCode: "timeout",
  reply: discordResponse(friendlyFailure, true),
};

const dataFailureOutcomes: Record<
  DataFailureScenario,
  readonly Pick<DiscordFailureObservation, "tenantCode" | "reply">[]
> = {
  slow: [sourceError, tenantTimeout],
  missing: [sourceError],
  malformed: [sourceError],
};

export function expectDataFailure(
  scenario: DataFailureScenario,
  observed: DiscordFailureObservation,
): void {
  expect(observed.fallback).toBeNull();
  expect(observed.fallbackCode).toBeNull();
  expect(observed.tenantPhase).toBe("committed");
  expect(dataFailureOutcomes[scenario]).toContainEqual({
    tenantCode: observed.tenantCode,
    reply: observed.reply,
  });
}
