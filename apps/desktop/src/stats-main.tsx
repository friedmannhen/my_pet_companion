import React from "react";
import { createRoot } from "react-dom/client";
import { StatsApp } from "./stats/StatsApp";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StatsApp />
  </React.StrictMode>,
);
