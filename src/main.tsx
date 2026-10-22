import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { detectShortcutPlatform } from "./keyboardShortcuts";
import "./index.css";

// CSS defaults to macOS chrome (product is mac-first). Mark other platforms
// so traffic-light inset is removed where Overlay titlebar does not apply.
const isMac =
  typeof navigator !== "undefined" &&
  detectShortcutPlatform(navigator) === "mac";
if (!isMac) {
  document.documentElement.classList.add("platform-other");
} else {
  document.documentElement.classList.add("platform-macos");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
