import { Layer } from "effect";
import { Block } from "foldkit";

import { EffectsLayer } from "./command";
import { LandingComposition } from "./composition";
import { Model } from "./model";
import { subscriptions } from "./subscription";
import { init, update } from "./update";
import { view } from "./view";

const prepare = () =>
  LandingComposition.prepareBlock({
    init,
    update,
    view,
    subscriptions,
    EffectsLayer: Layer.mergeAll(EffectsLayer, subscriptions.layer),
  });

export const LandingBlock: Block.FromAssemblyWithView<
  typeof Model,
  typeof prepare
> = Block.assemble(prepare);
