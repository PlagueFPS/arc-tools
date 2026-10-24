import { Schema } from "effect";

import { Enrollment, RequestId } from "./domain/enrollment";
import { AppRoute } from "./route";

export const Model = Schema.Struct({
  route: AppRoute,
  enrollment: Enrollment.schema,
  requestId: RequestId,
});

export type Model = typeof Model.Type;
