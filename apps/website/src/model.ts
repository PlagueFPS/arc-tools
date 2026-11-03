import { Schema } from "effect";

import { Enrollment, RequestId } from "./domain/enrollment";
import { Model as LandingModel } from "./landing/model";
import { ApplicationRoute } from "./route";
import { ThemeState } from "./theme";

export const Model = Schema.Struct({
  route: ApplicationRoute,
  theme: ThemeState,
  landing: LandingModel,
  enrollment: Enrollment.schema,
  leave: Enrollment.schema,
  requestId: RequestId,
});

export type Model = typeof Model.Type;
