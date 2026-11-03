import { Layer } from "effect";
import { Block } from "foldkit";

import { EffectsLayer } from "./command";
import { ApplicationComposition } from "./composition";
import { init, update, view } from "./main";
import type { Model } from "./model";
import { subscriptions } from "./subscription";

const prepare = () =>
  ApplicationComposition.prepareBlock({
    init,
    update,
    view,
    subscriptions,
    EffectsLayer: Layer.mergeAll(EffectsLayer, subscriptions.layer),
  });

export const ApplicationBlock: Block.FromAssemblyWithView<
  typeof Model,
  typeof prepare
> = Block.assemble(prepare);
