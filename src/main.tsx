import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// CSS defaults to macOS chrome (product is mac-first). Mark other platforms
// so traffic-light inset is removed where Overlay titlebar does not apply.
const isMac =
  typeof navigator !== "undefined" &&
  (/Mac|iPhone|iPod|iPad/i.test(navigator.platform) ||
    /Mac OS X|Macintosh/i.test(navigator.userAgent));
if (!isMac) {
  document.documentElement.classList.add("platform-other");
} else {
  document.documentElement.classList.add("platform-macos");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
