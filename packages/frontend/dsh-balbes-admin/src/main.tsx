import { createRoot } from "react-dom/client";
import { createApiClient } from "./api/client";

const root = document.getElementById("root");
if (root === null) throw new Error("no #root element");
createRoot(root).render(
  <div data-testid="app-root">
    <span data-testid="api-ready">api-ready</span>
  </div>
);
export const api = createApiClient();
