import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { probeCodeSessions, useCodeSetup } from "../../utils/codeApi";
import { settingsPath } from "../../utils/routes";
import CodeBlock from "../chat/CodeBlock";
import Modal, { ModalCancelButton } from "../shared/Modal";
import SettingsListHeader from "../settings/SettingsListHeader";

/**
 * Code sessions are known to the server but not set up (`useCodeSetup() === "setup"`): how to turn them
 * on. Shown by + ▸ Create ▸ Code session… (`CodeSetupDialog`, the code kind's `SetupDialog`) and by
 * Settings → Code (`CodeSetupSection`). Both switch to the real thing once a re-probe finds them.
 */

/** The smallest config that turns code sessions on; the same lines as in config.example.toml. */
const SNIPPET = `[code]
enabled = true

[[code.repos]]
name = "my-service"
path = "~/Code/my-service"
base = "main"`;

const DEFAULT_CONFIG_FILE = "~/.config/rye/config.toml";

let configFile: Promise<string> | null = null;

/** Where config.toml is: `/health` names it (it follows RYE_CONFIG_DIR); the default otherwise. */
function loadConfigFile(): Promise<string> {
  configFile ??= fetch("/health", { headers: { Accept: "application/json" } })
    .then((res) => (res.ok ? (res.json() as Promise<{ config_file?: unknown }>) : null))
    .then((data) => (typeof data?.config_file === "string" && data.config_file ? data.config_file : DEFAULT_CONFIG_FILE))
    .catch(() => {
      configFile = null;
      return DEFAULT_CONFIG_FILE;
    });
  return configFile;
}

function useConfigFile(): string {
  const [file, setFile] = useState(DEFAULT_CONFIG_FILE);
  useEffect(() => {
    let live = true;
    void loadConfigFile().then((f) => { if (live) setFile(f); });
    return () => { live = false; };
  }, []);
  return file;
}

/** "Check again": asks the server once more; `stillOff` once an answer came back still not set up. */
function useCheckAgain() {
  const setup = useCodeSetup();
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const check = async () => {
    setChecking(true);
    await probeCodeSessions(true);
    setChecking(false);
    setChecked(true);
  };
  return { check, checking, stillOff: checked && !checking && setup !== "available" };
}

/** The snippet to add and where the file is. */
function CodeSetupGuide({ stillOff }: { stillOff: boolean }) {
  const file = useConfigFile();
  return (
    <div className="code-setup">
      <p className="code-dialog-text">
        Add this to <code>config.toml</code>, with <code>path</code> set to a git repo of yours:
      </p>
      <div className="md-body code-setup-snippet">
        <CodeBlock>
          <code className="language-toml">{SNIPPET}</code>
        </CodeBlock>
      </div>
      <p className="code-form-hint">
        The file is <code className="code-setup-path">{file}</code>. Rye reads it when it changes, so there’s nothing to restart: save it, then check again.
      </p>
      {stillOff && (
        <p className="code-form-hint code-setup-still" role="status">
          Still not set up. Code sessions turn on once <code>[code]</code> lists at least one <code>[[code.repos]]</code>.
        </p>
      )}
    </div>
  );
}

/** + ▸ Create ▸ Code session… while code sessions aren't set up. */
export default function CodeSetupDialog({ onClose, onOpenPage }: { onClose: () => void; onOpenPage: (path: string) => void }) {
  const { check, checking, stillOff } = useCheckAgain();
  return (
    <Modal
      title="Set up code sessions"
      description="A code session is a coding agent working on a branch of its own, in a sandboxed copy of a repo. It never touches your checkout."
      className="modal--compact code-dialog code-setup-dialog"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost btn--sm code-setup-settings" onClick={() => onOpenPage(settingsPath("code"))}>
            Settings → Code
          </button>
          <ModalCancelButton label="Close" />
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void check()} disabled={checking}>
            {checking ? "Checking…" : "Check again"}
          </button>
        </>
      }
    >
      <CodeSetupGuide stillOff={stillOff} />
    </Modal>
  );
}

/** Settings → Code while code sessions aren't set up: the page's heading, then the same guidance. */
export function CodeSetupSection() {
  const { check, checking, stillOff } = useCheckAgain();
  return (
    <section className="settings-section code-settings" aria-labelledby="settings-code-title">
      <SettingsListHeader
        id="settings-code-title"
        title="Code"
        description="Coding agents that work on a branch in a sandboxed copy of an allowed repo."
        query=""
        onQueryChange={() => {}}
        searchPlaceholder="Search repos and sessions…"
        searchLabel="Search repos and code sessions"
        view="list"
        onViewChange={() => {}}
        disabled
        primary={{ label: checking ? "Checking…" : "Check again", icon: RefreshCw, onClick: () => void check(), disabled: checking }}
      />
      <div className="code-settings-group">
        <h4 className="code-settings-heading">Set up code sessions</h4>
        <div className="code-setup-card">
          <p className="code-dialog-text">
            Code sessions aren’t set up yet. Each one works on a branch of its own in a sandboxed copy of a repo, and never touches your checkout.
          </p>
          <CodeSetupGuide stillOff={stillOff} />
        </div>
      </div>
    </section>
  );
}
