import { policy } from "../../apps/bot/src/twitch-state.js";
import type {
  AccountAttribution,
  CompletedAlarmRun,
  ProviderAttribution,
} from "./alarm-attribution.js";
import { stableRunKey } from "./alarm-attribution.js";

type AccountJournal = typeof AccountAttribution.Type;

type ProviderJournal = typeof ProviderAttribution.Type;

type CompletedRun = typeof CompletedAlarmRun.Type;

export interface CompletedRunEvidence {
  readonly account: AccountJournal;
  readonly provider: ProviderJournal;
  readonly runKey: string;
}

export interface CompletedRecoveryEvidence {
  readonly account: AccountJournal;
  readonly provider: ProviderJournal;
  readonly earlyRunKey: string;
  readonly recoveryRunKey: string;
  readonly preparedInstance: string;
  readonly leaseUntil: number;
}

function requireEvidence(
  condition: boolean,
  reason: string,
): asserts condition {
  if (!condition)
    throw new Error(`Completed alarm evidence rejected: ${reason}`);
}

export function selectCompletedRun(
  account: AccountJournal,
  key: string,
): CompletedRun {
  const selected = account.completedRuns.filter((run) => run.key === key);
  requireEvidence(
    selected.length === 1 && selected[0] !== undefined,
    "missing or ambiguous completed run",
  );
  requireEvidence(stableRunKey(selected[0]) === key, "inconsistent run key");

  return selected[0];
}

export function completedRunKey(
  account: AccountJournal,
  alarmRun: number,
): string {
  const selected = account.completedRuns.filter(
    (run) => run.alarmRun === alarmRun,
  );

  requireEvidence(
    selected.length === 1 && selected[0] !== undefined,
    "missing or ambiguous durable alarm ordinal",
  );

  return selected[0].key;
}

function checkIntegrity(account: AccountJournal, provider: ProviderJournal) {
  requireEvidence(
    account.eventsDropped === 0 &&
      account.invocationsDropped === 0 &&
      account.completedRunsDropped === 0 &&
      account.integrityErrorsDropped === 0 &&
      provider.eventsDropped === 0 &&
      provider.credentialsDropped === 0,
    "truncated journal",
  );
  requireEvidence(
    account.integrityErrors.length === 0,
    "diagnostic storage failure",
  );
  requireEvidence(
    provider.events.every((event) => !event.correlationError),
    "invalid HTTP correlation",
  );
  requireEvidence(
    new Set(account.invocations.map((record) => record.id)).size ===
      account.invocations.length,
    "duplicate invocation UUID",
  );
  requireEvidence(
    new Set(provider.events.map((event) => event.id)).size ===
      provider.events.length,
    "duplicate HTTP event UUID",
  );
}

function runTraffic(
  run: CompletedRun,
  account: AccountJournal,
  provider: ProviderJournal,
  expected: 0 | 1,
) {
  requireEvidence(
    run.credential !== null,
    "missing completed credential fingerprint",
  );

  for (const kind of ["alarm-entry", "alarm-complete"] as const)
    requireEvidence(
      account.events.filter(
        (event) =>
          event.kind === kind &&
          event.instance === run.instance &&
          event.alarmRun === run.alarmRun,
      ).length === 1,
      "missing or ambiguous alarm lifecycle",
    );

  const invocations = account.invocations.filter(
    (record) =>
      record.instance === run.instance &&
      record.origin.operation === "alarm" &&
      record.origin.alarmRun === run.alarmRun,
  );

  requireEvidence(
    invocations.length === expected &&
      run.validationInvocationIds.length === expected,
    "wrong invocation count",
  );
  requireEvidence(
    invocations.every((record) =>
      run.validationInvocationIds.includes(record.id),
    ),
    "inconsistent completion invocation IDs",
  );
  requireEvidence(
    !provider.events.some(
      (event) =>
        event.correlation === null &&
        event.credentialFingerprint === run.credential?.fingerprint,
    ),
    "uncorrelated HTTP for completed credential",
  );

  const events = provider.events.filter((event) => {
    const correlation = event.correlation;

    return (
      correlation !== null &&
      ((correlation.instance === run.instance &&
        correlation.origin.operation === "alarm" &&
        correlation.origin.alarmRun === run.alarmRun) ||
        run.validationInvocationIds.includes(correlation.invocationId))
    );
  });

  requireEvidence(events.length === expected, "wrong actual HTTP count");

  if (expected === 0) return null;
  const invocation = invocations[0];
  const event = events[0];
  requireEvidence(
    invocation !== undefined && event?.correlation != null,
    "missing invocation or HTTP event",
  );
  requireEvidence(
    invocation.completion?.outcome === "success",
    "incomplete or unsuccessful invocation",
  );
  requireEvidence(
    event.correlation.invocationId === invocation.id &&
      event.correlation.instance === run.instance &&
      event.correlation.origin.operation === "alarm" &&
      event.correlation.origin.alarmRun === run.alarmRun &&
      invocation.credentialFingerprint === run.credential.fingerprint &&
      event.credentialFingerprint === invocation.credentialFingerprint,
    "HTTP UUID, fingerprint, or run mismatch",
  );

  return {
    runKey: run.key,
    invocationId: invocation.id,
    httpEventId: event.id,
  };
}

export function verifyCompletedValidation(evidence: CompletedRunEvidence) {
  checkIntegrity(evidence.account, evidence.provider);
  const run = selectCompletedRun(evidence.account, evidence.runKey);
  const result = runTraffic(run, evidence.account, evidence.provider, 1);
  requireEvidence(result !== null, "missing successful validation");

  return result;
}

export function verifyCompletedRecovery(evidence: CompletedRecoveryEvidence) {
  const { account, provider, leaseUntil, preparedInstance } = evidence;
  checkIntegrity(account, provider);
  const early = selectCompletedRun(account, evidence.earlyRunKey);
  const recovery = selectCompletedRun(account, evidence.recoveryRunKey);
  requireEvidence(
    early.alarmRun === 1 && recovery.alarmRun === 2,
    "unexpected recovery ordinals",
  );
  requireEvidence(
    early.instance !== preparedInstance &&
      recovery.instance !== preparedInstance,
    "missing reconstructed activation",
  );
  requireEvidence(
    early.entryAlarm === null &&
      early.lease?.until === leaseUntil &&
      early.accountTime < leaseUntil &&
      early.intended === leaseUntil &&
      early.native === leaseUntil,
    "early lease or native schedule mismatch",
  );
  requireEvidence(
    recovery.entryAlarm === null &&
      recovery.lease === null &&
      recovery.accountTime >= leaseUntil &&
      recovery.credential !== null &&
      recovery.intended !== null &&
      recovery.intended > recovery.accountTime &&
      recovery.native === recovery.intended,
    "recovery lease or native schedule mismatch",
  );
  requireEvidence(
    recovery.intended ===
      Math.min(
        recovery.credential.validatedAt + policy.hourlyMs,
        recovery.credential.expiresAt - 5_000,
      ),
    "recovery hourly schedule mismatch",
  );
  requireEvidence(
    early.credential?.fingerprint === recovery.credential.fingerprint,
    "recovery credential changed",
  );
  runTraffic(early, account, provider, 0);
  const result = runTraffic(recovery, account, provider, 1);
  requireEvidence(result !== null, "missing successful recovery");

  return { earlyRunKey: early.key, ...result };
}
