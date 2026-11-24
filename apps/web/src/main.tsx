import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SopProvider } from "./contexts/SopContext";
import { SkillProvider } from "./contexts/SkillContext";
import { MemoryProvider } from "./contexts/MemoryContext";
import { AgentProvider } from "./contexts/AgentContext";
import { EnvProvider } from "./contexts/EnvContext";
import { publishApiMutations } from "./utils/sync";
import "allo-font";
import "./index.css"
import { initTheme } from "./utils/theme";

initTheme();
publishApiMutations();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SopProvider>
      <SkillProvider>
        <MemoryProvider>
          <AgentProvider>
            <EnvProvider>
              <App />
            </EnvProvider>
          </AgentProvider>
        </MemoryProvider>
      </SkillProvider>
    </SopProvider>
  </React.StrictMode>
);
