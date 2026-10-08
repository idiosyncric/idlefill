import * as React from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/App";
import { seedFromDevConfig } from "@/lib/api";
import "@/index.css";

// Await the dev-config seed BEFORE the first render so the app's opening
// /api/state poll already carries the installed client's token. No-op in a
// production build.
seedFromDevConfig().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
