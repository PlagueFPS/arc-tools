import { Option, Result } from "effect";
import { AsyncData, type Runtime, type Update } from "foldkit";
import { UrlRequest } from "foldkit/navigation";
import { modifyFields } from "foldkit/struct";
import { type Url, toString as urlToString } from "foldkit/url";

import {
  CheckEnrollment,
  LoadExternal,
  NavigateInternal,
  ScrollToContent,
} from "./command";
import { CheckError, Enrollment, RequestId } from "./domain/enrollment";
import { Message } from "./message";
import { Model } from "./model";
import { AppRoute, urlToAppRoute } from "./route";

export { view } from "./view";

type UpdateReturn = Update.Return<Model, Message>;

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

  if (AppRoute.guards.NotFound(urlToAppRoute(url))) {
    return LoadExternal({ href });
  }

  return NavigateInternal({ url: href });
};

const startCheck = (model: Model): UpdateReturn => {
  if (!AppRoute.guards.Connect(model.route)) {
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

export const init: Runtime.RoutingApplicationInit<Model, Message> = (url) =>
  withContentScroll(
    startCheck({
      route: urlToAppRoute(url),
      enrollment: Enrollment.Idle(),
      requestId: RequestId.make(0),
    }),
    url,
  );

const acceptsResponse = (model: Model, requestId: typeof RequestId.Type) =>
  AppRoute.guards.Connect(model.route) &&
  model.requestId === requestId &&
  AsyncData.isPending(model.enrollment);

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    CompletedNavigateInternal: () => ({ model }),
    CompletedLoadExternal: () => ({ model }),
    CompletedScrollToContent: () => ({ model }),
    ClickedLink: ({ request }) =>
      UrlRequest.match<UpdateReturn>(request, {
        Internal: ({ url }) => ({
          model,
          commands: [spaNavigation(url)],
        }),
        External: ({ href }) => ({ model, commands: [LoadExternal({ href })] }),
      }),
    ChangedUrl: ({ url }) => {
      const route = urlToAppRoute(url);

      if (
        AppRoute.guards.Connect(route) &&
        AppRoute.guards.Connect(model.route)
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

      return withContentScroll(startCheck(nextModel), url);
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
  });
