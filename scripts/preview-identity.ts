import { createHash } from "node:crypto";
import { Schema } from "effect";

export const Repository = Schema.Literal("PlagueFPS/arc-tools");
export const PrNumber = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
).pipe(Schema.brand("PrNumber"));
export const Revision = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{40}$/),
).pipe(Schema.brand("Revision"));
export const PreviewStage = Schema.String.check(
  Schema.isPattern(/^test-tenant-[a-f0-9]{8}-[a-f0-9]{12}$/),
).pipe(Schema.brand("PreviewStage"));

export function previewIdentity(input: {
  repository: unknown;
  number: unknown;
}) {
  const { repository, number } = Schema.decodeUnknownSync(
    Schema.Struct({ repository: Repository, number: PrNumber }),
  )(input);
  const hash = createHash("sha256")
    .update(`${repository.toLowerCase()}#${number}`)
    .digest("hex");
  const run = hash.slice(8, 20);
  const stage = Schema.decodeUnknownSync(PreviewStage)(
    `test-tenant-${hash.slice(0, 8)}-${run}`,
  );
  return { repository, number, stage, run };
}
export type PreviewIdentity = ReturnType<typeof previewIdentity>;

export const PullRequest = Schema.Struct({
  state: Schema.Literals(["open", "closed"]),
  head: Schema.Struct({
    sha: Revision,
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  }),
  base: Schema.Struct({ repo: Schema.Struct({ full_name: Repository }) }),
  merge_commit_sha: Schema.NullOr(Revision),
});
export type PullRequest = typeof PullRequest.Type;

export const CheckedPreview = Schema.Struct({
  revision: Revision,
  head: Revision,
});
export type CheckedPreview = typeof CheckedPreview.Type;

export function previewDecision(
  pr: PullRequest,
  checked: CheckedPreview,
): "destroy" | "deploy" | "stale" {
  if (pr.state === "closed") return "destroy";
  if (pr.head.repo?.full_name !== pr.base.repo.full_name)
    throw new Error("Fork pull requests cannot use preview credentials");
  return pr.head.sha === checked.head &&
    pr.merge_commit_sha === checked.revision
    ? "deploy"
    : "stale";
}

export const PublicOrigin = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value;
    } catch {
      return false;
    }
  }),
);

export const PreviewOutput = Schema.Struct({
  stage: PreviewStage,
  url: PublicOrigin,
});

export function previewAction(args: string[]): {
  action: "deploy" | "cleanup";
  number: typeof PrNumber.Type;
} {
  const [action, flag, number, ...rest] = args;
  if (
    (action !== "deploy" && action !== "cleanup") ||
    flag !== "--pr" ||
    !number ||
    !/^[1-9][0-9]*$/.test(number) ||
    rest.length
  )
    throw new Error("Use preview deploy|cleanup --pr <positive PR number>");
  return { action, number: Schema.decodeUnknownSync(PrNumber)(Number(number)) };
}
