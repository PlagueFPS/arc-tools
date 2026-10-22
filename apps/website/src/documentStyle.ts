import * as stylex from "@stylexjs/stylex";

import { elementClass } from "./styles";
import { fonts } from "./theme.stylex";

const styles = stylex.create({
  document: {
    fontFamily: fonts.body,
    color: "#f2efe6",
    backgroundColor: "#151517",
    fontSynthesis: "none",
    textRendering: "optimizeLegibility",
    WebkitFontSmoothing: "antialiased",
    colorScheme: "dark",
  },
  body: {
    marginTop: 0,
    marginRight: 0,
    marginBottom: 0,
    marginLeft: 0,
  },
});

export const documentClass = elementClass(styles.document);

export const bodyClass = elementClass(styles.body);
