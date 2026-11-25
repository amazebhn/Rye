import React from "react";
import { setStripedRows, useStripedRows } from "../../utils/tablePrefs";

/** Table display preferences (Settings → General → Appearance). */
export default function TableSetting() {
  const striped = useStripedRows();
  return (
    <div className="settings-task-list">
      <div className="settings-task">
        <div className="settings-task-text">
          <span className="settings-task-name" id="table-stripes-label">Striped table rows</span>
          <span className="settings-task-desc">Shade every other row in tables, full-screen results and query output.</span>
        </div>
        <input
          type="checkbox"
          role="switch"
          className="settings-switch"
          checked={striped}
          onChange={(e) => setStripedRows(e.target.checked)}
          aria-labelledby="table-stripes-label"
        />
      </div>
    </div>
  );
}
