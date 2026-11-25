import React, { createContext, useContext } from "react";
import { Menu, PanelLeftOpen } from "lucide-react";

/**
 * How a page's top bar opens the sidebar. On a phone (utils/viewport.ts) the sidebar is a drawer and
 * every page shows a menu button; on a wider screen the button only appears while the sidebar is collapsed.
 */
export interface SidebarControl {
  /** The sidebar is a drawer over the content (phone width). */
  drawer: boolean;
  /** The sidebar is showing (the drawer is open, or the desktop column is expanded). */
  open: boolean;
  /** Opens it; the trigger gets focus back when the drawer closes. */
  show: (trigger: HTMLElement | null) => void;
}

export const SidebarControlContext = createContext<SidebarControl>({
  drawer: false,
  open: true,
  show: () => {},
});

export function useSidebarControl(): SidebarControl {
  return useContext(SidebarControlContext);
}

/** The top bar's sidebar button. Renders nothing while the desktop sidebar is already showing. */
export default function SidebarButton() {
  const { drawer, open, show } = useSidebarControl();
  if (drawer) {
    return (
      <button
        type="button"
        className="icon-btn sidebar-toggle-btn"
        onClick={(e) => show(e.currentTarget)}
        title="Open menu"
        aria-label="Open menu"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="app-sidebar"
      >
        <Menu size={20} aria-hidden="true" />
      </button>
    );
  }
  if (open) return null;
  return (
    <button
      type="button"
      className="icon-btn sidebar-toggle-btn"
      style={{ color: "var(--main-fg-muted)" }}
      onClick={(e) => show(e.currentTarget)}
      title="Open sidebar"
    >
      <PanelLeftOpen size={18} />
    </button>
  );
}
