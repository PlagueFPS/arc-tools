import { Runtime } from "foldkit";

import { init, update, view } from "./main";
import { Message } from "./message";
import { Model } from "./model";

import "./styles.css";

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  container: document.getElementById("root"),
  routing: {
    onUrlRequest: (request) => Message.ClickedLink({ request }),
    onUrlChange: (url) => Message.ChangedUrl({ url }),
  },
  devTools: { Message },
});

Runtime.hydrate(application);
