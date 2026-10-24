import { Block } from "foldkit";

import { EffectsLayer } from "./command";
import { ApplicationComposition } from "./composition";
import { init, update, view } from "./main";
import type { Model } from "./model";

const prepare = () =>
  ApplicationComposition.prepareBlock({ init, update, view, EffectsLayer });

export const ApplicationBlock: Block.FromAssemblyWithView<
  typeof Model,
  typeof prepare
> = Block.assemble(prepare);
