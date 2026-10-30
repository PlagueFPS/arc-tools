import type { Block } from "foldkit";

import { ApplicationDefinition } from "./definition";
import { LandingBlock } from "./landing/block";
import { ApplicationRoute } from "./route";

export const LandingBinding = ApplicationDefinition.makeBinding(LandingBlock, {
  field: "landing",
  presentWhen: (model) => ApplicationRoute.guards.Home(model.route),
});

export const ApplicationComposition = ApplicationDefinition.makeComposition({
  bindings: [LandingBinding],
});

export type ApplicationViewBuilder = Block.ViewBuilderFor<
  typeof ApplicationComposition
>;
