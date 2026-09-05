import { createRoot } from "react-dom/client";
import App from "./App";
import { createApiClient } from "./api/client";
import "./styles.css";

const api = createApiClient();
const root = document.getElementById("root");
if (root === null) throw new Error("no #root element");
createRoot(root).render(<App api={api} />);
