import React, { useEffect, useState } from "react";
import {
  requestNotificationPermission,
  sendTestNotification,
  useNotificationPrefs,
  useNotificationSupport,
  type NotificationPrefs,
  type NotificationSupport,
} from "../../utils/notifications";

const TYPES: Array<{ key: keyof Omit<NotificationPrefs, "enabled">; name: string; desc: string }> = [
  { key: "reply", name: "Replies", desc: "A reply finished (once per run, after any hand-offs between agents)." },
  { key: "waiting", name: "Waiting for you", desc: "The agent asked a question or needs a tool approved. Stays up until you act." },
  { key: "error", name: "Errors", desc: "A run failed." },
];

function statusLine(support: NotificationSupport, enabled: boolean): { ok: boolean; text: string } {
  switch (support) {
    case "unsupported":
      return { ok: false, text: "This browser doesn't support notifications." };
    case "insecure":
      return { ok: false, text: `Notifications need a secure address (https, or localhost). This page is ${window.location.origin}.` };
    case "denied":
      return {
        ok: false,
        text: "Blocked for this site. To allow them, open the site settings (the icon left of the address), set Notifications to Allow, then reload.",
      };
    case "granted":
      return {
        ok: true,
        text: enabled
          ? "Allowed in this browser. If none appear, check that your system allows notifications from this browser."
          : "Allowed in this browser.",
      };
    default:
      return { ok: false, text: "Your browser asks for permission when you turn this on." };
  }
}

/** Settings → General → Notifications: desktop notifications from this browser (kept in localStorage). */
export default function NotificationsSetting() {
  const [prefs, setPrefs] = useNotificationPrefs();
  const [support, setSupport] = useNotificationSupport();
  const [asking, setAsking] = useState(false);
  const [tested, setTested] = useState(false);
  useEffect(() => {
    if (!tested) return;
    const timer = window.setTimeout(() => setTested(false), 4000);
    return () => window.clearTimeout(timer);
  }, [tested]);

  const on = prefs.enabled && support === "granted";
  const canAsk = support === "default" || support === "granted";
  const status = statusLine(support, on);

  async function toggle(next: boolean) {
    if (!next) return setPrefs({ enabled: false });
    // Straight from the click, so the browser shows its permission prompt.
    setAsking(true);
    const result = await requestNotificationPermission();
    setAsking(false);
    setSupport(result);
    setPrefs({ enabled: result === "granted" });
  }

  return (
    <section className="settings-section" aria-labelledby="settings-notify-title">
      <div className="settings-section-head">
        <h3 className="settings-section-title" id="settings-notify-title">Notifications</h3>
        <p className="settings-section-desc">
          Only when you aren't looking at that chat: Rye is in another tab or window, or another chat is open. Set per browser.
        </p>
      </div>
      <div className="settings-task-list">
        <div className="settings-task">
          <label className="settings-task-text" htmlFor="settings-notify-enabled">
            <span className="settings-task-name">Desktop notifications</span>
            <span className="settings-task-desc">The tab title counts what's new either way, e.g. “(2) Rye”.</span>
          </label>
          <input
            id="settings-notify-enabled"
            type="checkbox"
            role="switch"
            className="settings-switch"
            checked={on}
            disabled={!canAsk || asking}
            aria-describedby="settings-notify-status"
            onChange={(e) => void toggle(e.target.checked)}
          />
        </div>
      </div>
      <p
        id="settings-notify-status"
        className={`settings-decision-status settings-notify-status ${status.ok ? "is-ok" : "is-missing"}`}
        role="status"
      >
        {status.text}
      </p>
      <div className="settings-task-list settings-notify-types" aria-disabled={on ? undefined : true}>
        {TYPES.map((type) => (
          <div className="settings-task" key={type.key}>
            <label className="settings-task-text" htmlFor={`settings-notify-${type.key}`}>
              <span className="settings-task-name">{type.name}</span>
              <span className="settings-task-desc">{type.desc}</span>
            </label>
            <input
              id={`settings-notify-${type.key}`}
              type="checkbox"
              role="switch"
              className="settings-switch"
              checked={prefs[type.key]}
              disabled={!on}
              onChange={(e) => setPrefs({ [type.key]: e.target.checked })}
            />
          </div>
        ))}
        <div className="settings-task">
          <div className="settings-task-text">
            <span className="settings-task-name">Test</span>
            <span className="settings-task-desc" role="status">
              {tested ? "Sent. It shows even while you're here." : "Send one now to see how they look."}
            </span>
          </div>
          <button type="button" className="settings-reset" disabled={!on} onClick={() => setTested(sendTestNotification())}>
            Send test notification
          </button>
        </div>
      </div>
    </section>
  );
}
