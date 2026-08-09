import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./tokens.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element missing");

createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
