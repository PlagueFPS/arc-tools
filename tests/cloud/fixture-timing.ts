import { Array as EffectArray, Record as EffectRecord } from "effect";

import type { Work } from "../../apps/bot/src/tenant-state.js";
import type { TenantSnapshot } from "./tenant-fixture.js";

export const immutableWork = (work: Work) => ({
  id: work.id,
  fingerprint: work.fingerprint,
  receivedAt: work.receivedAt,
  deadline: work.deadline,
  retainUntil: work.retainUntil,
});

export const hasUsefulNativeSchedule = (
  snapshot: typeof TenantSnapshot.Type,
  deadline: number,
) =>
  snapshot.alarm !== null
    ? snapshot.alarm <= deadline ||
      EffectArray.every(
        EffectRecord.values(snapshot.state?.works ?? {}),
        (work) => !!(work.kind === "terminal"),
      )
    : snapshot.alarmActivity.running?.instance === snapshot.instance ||
      (snapshot.alarmActivity.completed?.instance === snapshot.instance &&
        EffectArray.every(
          EffectRecord.values(snapshot.state?.works ?? {}),
          (work) =>
            !!(
              work.kind === "terminal" &&
              snapshot.alarmActivity.completed?.workIds.includes(work.id)
            ),
        ));

export const ingressTiming = (headers: Headers) => {
  const stamp = headers.get("x-arc-ingress-ms");

  if (stamp === null || !/^\d+$/.test(stamp) || !Number.isFinite(Number(stamp)))
    throw new Error("Missing or invalid ingress timing stamp");

  return Number(stamp);
};
