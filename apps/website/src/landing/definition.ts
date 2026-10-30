import { Block } from "foldkit";

import { Message } from "./message";
import { Model } from "./model";

export const LandingDefinition = Block.makeDefinition("Landing", {
  Model,
  Message,
});
