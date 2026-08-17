import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { bootstrapAccess } from "./api";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

function render(authenticated: boolean) {
  root.render(authenticated
    ? <StrictMode><App /></StrictMode>
    : <main className="access-required">
        <div>
          <strong>OpenCode Control</strong>
          <h1>Access required / Требуется доступ</h1>
          <p>Open Control with <code>opencode-control start</code> to authorize this browser.</p>
        </div>
      </main>);
}

void bootstrapAccess().then(render).catch(() => render(false));
