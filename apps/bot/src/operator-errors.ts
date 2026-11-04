import { Schema } from "effect";
import { HttpApiError } from "effect/http-api";

export class OperatorUnauthorized extends HttpApiError.Problem<OperatorUnauthorized>()(
  "OperatorUnauthorized",
  {
    type: "urn:arctools:problem:operator-unauthorized",
    status: 401,
    title: "Operator authentication is required.",
  },
  { error: Schema.tag("unauthorized") },
) {}

export class OperatorStageMismatch extends HttpApiError.Problem<OperatorStageMismatch>()(
  "OperatorStageMismatch",
  {
    type: "urn:arctools:problem:operator-stage-mismatch",
    status: 409,
    title: "The requested stage does not match this bot.",
  },
  { error: Schema.tag("stage-mismatch") },
) {}

export class OperatorInvalidRequest extends HttpApiError.Problem<OperatorInvalidRequest>()(
  "OperatorInvalidRequest",
  {
    type: "urn:arctools:problem:operator-invalid-request",
    status: 400,
    title: "The request must contain a valid stage as JSON.",
  },
  { error: Schema.tag("invalid-request") },
) {}

export class OperatorBodyTooLarge extends HttpApiError.Problem<OperatorBodyTooLarge>()(
  "OperatorBodyTooLarge",
  {
    type: "urn:arctools:problem:operator-body-too-large",
    status: 413,
    title: "The request body exceeds 4096 bytes.",
  },
  { error: Schema.tag("body-too-large") },
) {}

export class OperatorBusy extends HttpApiError.Problem<OperatorBusy>()(
  "OperatorBusy",
  {
    type: "urn:arctools:problem:operator-busy",
    status: 503,
    title: "Another operator operation is in progress. Retry shortly.",
  },
  { error: Schema.tag("operator-busy") },
) {}

export class OperatorCapacityExceeded extends HttpApiError.Problem<OperatorCapacityExceeded>()(
  "OperatorCapacityExceeded",
  {
    type: "urn:arctools:problem:operator-capacity-exceeded",
    status: 409,
    title: "The channel capacity has been exceeded.",
  },
  { error: Schema.tag("channel-capacity-exceeded") },
) {}

export class OperatorOperationFailed extends HttpApiError.Problem<OperatorOperationFailed>()(
  "OperatorOperationFailed",
  {
    type: "urn:arctools:problem:operator-operation-failed",
    status: 503,
    title: "The operator operation could not be completed.",
  },
  { error: Schema.tag("operator-operation-failed") },
) {}

export const operatorErrors = [
  OperatorUnauthorized,
  OperatorStageMismatch,
  OperatorInvalidRequest,
  OperatorBodyTooLarge,
  OperatorBusy,
  OperatorCapacityExceeded,
  OperatorOperationFailed,
];
