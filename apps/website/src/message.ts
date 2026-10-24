import { defineMessageUnion } from "foldkit/message";
import { UrlRequest } from "foldkit/navigation";
import { Url } from "foldkit/url";

import { CheckError, EnrollmentStatus, RequestId } from "./domain/enrollment";

export const Message = defineMessageUnion({
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url },
  CompletedNavigateInternal: {},
  CompletedLoadExternal: {},
  CompletedScrollToContent: {},
  CompletedCancelCheck: {},
  ClickedCheckStatus: {},
  SucceededCheckEnrollment: { requestId: RequestId, status: EnrollmentStatus },
  FailedCheckEnrollment: { requestId: RequestId, error: CheckError },
});

export type Message = typeof Message.Type;
