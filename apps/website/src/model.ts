import { Schema } from "effect";

import { Enrollment, RequestId } from "./domain/enrollment";
import { ApplicationRoute } from "./route";

export const Model = Schema.Struct({
  route: ApplicationRoute,
  enrollment: Enrollment.schema,
  leave: Enrollment.schema,
  requestId: RequestId,
});

export type Model = typeof Model.Type;
