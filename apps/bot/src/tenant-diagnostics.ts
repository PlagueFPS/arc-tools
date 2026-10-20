import { Context, Schema } from "effect";

export const TenantTrace = Schema.Struct({
  phase: Schema.Literals(["admission", "committed", "uncommitted"]),
  code: Schema.Literals([
    "rpc-entry",
    "accepted",
    "duplicate",
    "input",
    "conflict",
    "capacity",
    "success",
    "command-error",
    "command-defect",
    "timeout",
    "interrupted",
    "recorded",
    "missing",
    "wait-limit",
  ]),
  admissionDeltaMs: Schema.Number,
  cutoff: Schema.Number,
  activation: Schema.String,
});

export type TenantTrace = typeof TenantTrace.Type;

export const TenantDiagnostic = Context.Reference<{
  readonly admission: (trace: TenantTrace) => void;
  readonly decision: (
    phase: TenantTrace["phase"],
    code: TenantTrace["code"],
  ) => void;
}>("@arctools/TenantDiagnostic", {
  defaultValue: () => ({ admission: () => {}, decision: () => {} }),
});

export const TenantBoundaryObserver = Context.Reference<{
  readonly lookup: () => void;
  readonly rpc: () => void;
  readonly result: (trace: TenantTrace) => void;
}>("@arctools/TenantBoundaryObserver", {
  defaultValue: () => ({ lookup: () => {}, rpc: () => {}, result: () => {} }),
});
