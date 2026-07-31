import { createRoot } from "react-dom/client";

import "./i18n/index.js";
import { App } from "./App.jsx";
import "./styles/common.css";

createRoot(document.getElementById("root")).render(<App />);
