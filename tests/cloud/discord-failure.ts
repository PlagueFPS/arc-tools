import { expect } from "bun:test";

import { discordResponse } from "../../apps/bot/src/presentation.js";

export type DataFailureScenario = "slow" | "missing" | "malformed";

export type DiscordFailureObservation = {
  reply: unknown;
  tenantPhase: string | null;
  tenantCode: string | null;
  fallback: string | null;
  fallbackCode: string | null;
};

export function expectDataFailure(
  _scenario: DataFailureScenario,
  observed: DiscordFailureObservation,
): void {
  expect(observed.fallback).toBeNull();
  expect(observed.fallbackCode).toBeNull();
  expect(observed.tenantPhase).toBe("committed");
  expect(observed.reply).toEqual(
    discordResponse(
      "Game data is temporarily unavailable. Please try again shortly.",
      true,
    ),
  );
  expect(observed.tenantCode).toBe("command-error");
}
