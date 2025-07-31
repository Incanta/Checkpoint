import { hydrateRoot, createRoot } from "react-dom/client";

import App from "./App";
import Routes from "./Routes";

/**
 * Find the app element to mount React to
 */
const appElement = document.getElementById("redwood-app") || document.getElementById("root");

if (!appElement) {
  throw new Error(
    "Could not find an element with ID 'redwood-app' or 'root'. Please ensure it " +
      "exists in your HTML file.",
  );
}

if (appElement.children?.length > 0) {
  hydrateRoot(
    appElement,
    <App>
      <Routes />
    </App>,
  );
} else {
  const root = createRoot(appElement);
  root.render(
    <App>
      <Routes />
    </App>,
  );
}
