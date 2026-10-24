import { Option, Result } from "effect";
import { AsyncData, type Command, type Update } from "foldkit";
import { UrlRequest } from "foldkit/navigation";
import { modifyFields } from "foldkit/struct";
import { type Url, toString as urlToString } from "foldkit/url";

import {
  CheckEnrollment,
  LoadExternal,
  NavigateInternal,
  ScrollToContent,
} from "./command";
import { ApplicationComposition } from "./composition";
import { CheckError, Enrollment, RequestId } from "./domain/enrollment";
import { Message } from "./message";
import { Model } from "./model";
import { ApplicationRoute, urlToApplicationRoute } from "./route";

export { view } from "./view";

type CommandRequirements = Command.HandlerOf<
  | typeof CheckEnrollment
  | typeof LoadExternal
  | typeof NavigateInternal
  | typeof ScrollToContent
>;

type UpdateReturn = Update.Return<Model, Message, CommandRequirements>;

const contentScroll = (url: Url): UpdateReturn["commands"] =>
  Option.match(url.hash, {
    onNone: () => undefined,
    onSome: (hash) => [ScrollToContent({ hash })],
  });

const withContentScroll = (result: UpdateReturn, url: Url): UpdateReturn => {
  const scroll = contentScroll(url);

  if (scroll === undefined) {
    return result;
  }

  return {
    ...result,
    commands: [...(result.commands ?? []), ...scroll],
  };
};

const spaNavigation = (url: Url) => {
  const href = urlToString(url);

  if (ApplicationRoute.guards.NotFound(urlToApplicationRoute(url))) {
    return LoadExternal({ href });
  }

  return NavigateInternal({ url: href });
};

const startCheck = (model: Model): UpdateReturn => {
  if (!ApplicationRoute.guards.Connect(model.route)) {
    return { model };
  }

  return Option.match(AsyncData.revalidateOrLoad(model.enrollment), {
    onNone: () => ({ model }),
    onSome: (enrollment) => {
      const requestId = RequestId.make(model.requestId + 1);

      return {
        model: modifyFields(model, {
          enrollment: () => enrollment,
          requestId: () => requestId,
        }),
        commands: [CheckEnrollment({ requestId })],
      };
    },
  });
};

export const init = ApplicationComposition.makeInit((url: Url) =>
  withContentScroll(
    startCheck({
      route: urlToApplicationRoute(url),
      enrollment: Enrollment.Idle(),
      requestId: RequestId.make(0),
    }),
    url,
  ),
);

const acceptsResponse = (model: Model, requestId: typeof RequestId.Type) =>
  ApplicationRoute.guards.Connect(model.route) &&
  model.requestId === requestId &&
  AsyncData.isPending(model.enrollment);

export const update = ApplicationComposition.makeUpdate((model, message) =>
  Message.match(message, {
    CompletedNavigateInternal: () => ({ model }),
    CompletedLoadExternal: () => ({ model }),
    CompletedScrollToContent: () => ({ model }),
    CompletedCancelCheck: () => ({ model }),
    ClickedLink: ({ request }) =>
      UrlRequest.match<UpdateReturn>(request, {
        Internal: ({ url }) => ({
          model,
          commands: [spaNavigation(url)],
        }),
        External: ({ href }) => ({ model, commands: [LoadExternal({ href })] }),
      }),
    ChangedUrl: ({ url }) => {
      const route = urlToApplicationRoute(url);

      if (
        ApplicationRoute.guards.Connect(route) &&
        ApplicationRoute.guards.Connect(model.route)
      ) {
        return withContentScroll({ model }, url);
      }

      const nextModel = modifyFields(model, {
        route: () => route,
        requestId: (requestId) => RequestId.make(requestId + 1),
        enrollment: (enrollment) =>
          Option.match(AsyncData.getData(enrollment), {
            onNone: () => Enrollment.Idle(),
            onSome: (data) => Enrollment.Success({ data }),
          }),
      });

      const next = startCheck(nextModel);

      return withContentScroll(
        AsyncData.isPending(model.enrollment)
          ? {
              ...next,
              commands: [
                CheckEnrollment.Interrupt({ requestId: model.requestId }, () =>
                  Message.CompletedCancelCheck(),
                ),
                ...(next.commands ?? []),
              ],
            }
          : next,
        url,
      );
    },
    ClickedCheckStatus: () => startCheck(model),
    SucceededCheckEnrollment: ({ requestId, status }) =>
      acceptsResponse(model, requestId)
        ? {
            model: modifyFields(model, {
              enrollment: () => Enrollment.Success({ data: status }),
            }),
          }
        : { model },
    FailedCheckEnrollment: ({ requestId, error }) =>
      acceptsResponse(model, requestId)
        ? {
            model: modifyFields(model, {
              enrollment: (enrollment) =>
                CheckError.guards.Absent(error)
                  ? Enrollment.Failure({ error })
                  : AsyncData.settle(enrollment, Result.fail(error)),
            }),
          }
        : { model },
  }),
);
