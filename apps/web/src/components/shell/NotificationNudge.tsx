import React from "react";
import { Bell } from "lucide-react";
import { useNotificationNudge } from "../../utils/notifications";

/**
 * Shown once, after the first long run that finished while Rye's tab was hidden, when
 * notifications are off and could be turned on. Either button puts it away for good.
 */
export default function NotificationNudge() {
  const [showing, close] = useNotificationNudge();
  return (
    <div className="notify-nudge-region" role="status" aria-live="polite">
      {showing && (
        <div className="folder-toast notify-nudge" role="group" aria-label="Turn on notifications">
          <Bell size={16} className="folder-toast-icon" aria-hidden="true" />
          <div className="folder-toast-body">
            <p className="folder-toast-text">Turn on notifications? Rye can tell you when a reply is ready or it needs you.</p>
          </div>
          <div className="folder-toast-actions">
            <button type="button" className="btn btn--primary btn--sm" onClick={() => close(true)}>Open settings</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => close(false)}>No thanks</button>
          </div>
        </div>
      )}
    </div>
  );
}
