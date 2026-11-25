/**
 * How tables are drawn, set in Settings → General and kept in this browser.
 * Every table viewer reads it through the hook, so a change applies everywhere
 * at once (and in other tabs, through the storage event).
 */

import { useEffect, useState } from "react";

const STRIPES_KEY = "rye-table-stripes";
const CHANGED = "rye-table-prefs-changed";

export function readStripedRows(): boolean {
  try {
    return localStorage.getItem(STRIPES_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setStripedRows(on: boolean): void {
  try {
    if (on) localStorage.removeItem(STRIPES_KEY);
    else localStorage.setItem(STRIPES_KEY, "off");
  } catch {
    // Private mode: the change lasts for this page only.
  }
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: on }));
}

/** Whether table rows are striped; updates when it is changed here or in another tab. */
export function useStripedRows(): boolean {
  const [on, setOn] = useState(readStripedRows);
  useEffect(() => {
    const here = (e: Event) => setOn((e as CustomEvent<boolean>).detail);
    const elsewhere = (e: StorageEvent) => {
      if (e.key === STRIPES_KEY || e.key === null) setOn(readStripedRows());
    };
    window.addEventListener(CHANGED, here);
    window.addEventListener("storage", elsewhere);
    return () => {
      window.removeEventListener(CHANGED, here);
      window.removeEventListener("storage", elsewhere);
    };
  }, []);
  return on;
}
