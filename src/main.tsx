import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import WorldclassApp from "./worldclass/App";

const root = document.getElementById("root");
if (!root) throw new Error("Application root was not found");
createRoot(root).render(<StrictMode><WorldclassApp /></StrictMode>);
