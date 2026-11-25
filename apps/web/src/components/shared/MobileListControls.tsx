import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Check, ChevronDown, RefreshCw, RotateCcw, Search, SlidersHorizontal, X, type LucideIcon } from "lucide-react";
import Modal from "./Modal";
import { useIsMobile } from "../../utils/viewport";
import { usePullToRefresh, PULL_THRESHOLD } from "../../utils/usePullToRefresh";
import { useSidebarControl } from "../shell/SidebarButton";

/*
 * The phone-width controls of a list page (SOPs, Agents, Memory, the Settings list pages). The top bar
 * keeps only the menu button, the title and the primary action; search and filters float at the
 * bottom, within thumb reach, and the list refreshes by pulling it down. Nothing here renders above
 * MOBILE_BREAKPOINT, so wider layouts keep their toolbars untouched.
 */

/** How high the on-screen keyboard covers the window, so the floating search field can sit above it. */
function useKeyboardInset(active: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) {
      setInset(0);
      return;
    }
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [active]);
  return inset;
}

interface MobileListControlsProps {
  query: string;
  onQueryChange: (query: string) => void;
  /** The search button's and field's name, e.g. "Search SOPs". */
  searchLabel: string;
  searchPlaceholder?: string;
  /** The filter sheet's contents (SheetOptions, SheetActions…). Left out, there is no filter button. */
  filters?: React.ReactNode;
  /** Filters (and sort orders) changed from their defaults: the badge on the filter button. */
  activeFilters?: number;
  /** Puts every filter back to its default; offered in the sheet while any is active. */
  onResetFilters?: () => void;
  /** The sheet's heading. */
  filterTitle?: string;
  /** Hides the controls, e.g. while a detail view or an editor covers the list. */
  hidden?: boolean;
}

/**
 * Floating search and filter buttons at the bottom right of a list page, on a phone only. Render it
 * inside the list's scroll container (`.sop-panel-body`): the container then leaves room at its end
 * so the last row is never under the buttons. The controls hide while the sidebar drawer is open.
 */
export default function MobileListControls({
  query,
  onQueryChange,
  searchLabel,
  searchPlaceholder,
  filters,
  activeFilters = 0,
  onResetFilters,
  filterTitle = "Filters",
  hidden = false,
}: MobileListControlsProps) {
  const isMobile = useIsMobile();
  const sidebar = useSidebarControl();
  const [searching, setSearching] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchBtnRef = useRef<HTMLButtonElement>(null);
  const filterBtnRef = useRef<HTMLButtonElement>(null);
  // Where focus goes once the field or the sheet closes: back to the button that opened it.
  const returnFocus = useRef<"search" | "filter" | null>(null);
  const inputId = useId();
  const keyboard = useKeyboardInset(searching);

  const drawerOpen = sidebar.drawer && sidebar.open;
  const shown = isMobile && !hidden && !drawerOpen;

  useEffect(() => {
    if (!shown) {
      setSearching(false);
      setSheetOpen(false);
    }
  }, [shown]);

  useLayoutEffect(() => {
    if (searching || sheetOpen || !returnFocus.current) return;
    const target = returnFocus.current === "search" ? searchBtnRef.current : filterBtnRef.current;
    returnFocus.current = null;
    target?.focus();
  }, [searching, sheetOpen]);

  if (!shown) return null;

  function openSearch() {
    // Focus inside the tap itself: iOS only raises the keyboard for a focus made during a user gesture.
    flushSync(() => setSearching(true));
    inputRef.current?.focus();
  }

  // Closed by leaving the field (a tap elsewhere, the keyboard's Done), focus stays where it went.
  function closeSearch(restoreFocus: boolean) {
    if (restoreFocus) returnFocus.current = "search";
    setSearching(false);
  }

  function closeSheet() {
    returnFocus.current = "filter";
    setSheetOpen(false);
  }

  const filtered = query.trim() !== "";
  // Buttons inside the field keep the focus in it, so tapping them doesn't count as leaving the field.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  return (
    <>
      <div
        className={`mlc${searching ? " is-searching" : ""}`}
        style={keyboard > 0 ? ({ "--mlc-keyboard": `${keyboard}px` } as React.CSSProperties) : undefined}
      >
        {searching ? (
          <div className="mlc-search" role="search">
            <Search size={16} className="mlc-search-icon" aria-hidden="true" />
            <label htmlFor={inputId} className="mlc-sr-only">{searchLabel}</label>
            <input
              ref={inputRef}
              id={inputId}
              className="mlc-search-input"
              type="search"
              enterKeyHint="search"
              autoComplete="off"
              placeholder={searchPlaceholder ?? `${searchLabel}…`}
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  closeSearch(true);
                } else if (e.key === "Enter") {
                  e.currentTarget.blur();
                }
              }}
              onBlur={() => closeSearch(false)}
            />
            {filtered && (
              <button
                type="button"
                className="mlc-search-btn"
                onMouseDown={keepFocus}
                onClick={() => onQueryChange("")}
                aria-label="Clear search"
                title="Clear search"
              >
                <X size={16} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="mlc-search-btn"
              onMouseDown={keepFocus}
              onClick={() => closeSearch(true)}
              aria-label="Close search"
              title="Close search"
            >
              <ChevronDown size={18} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <div className="mlc-cluster">
            {filters && (
              <button
                ref={filterBtnRef}
                type="button"
                className={`mlc-fab${activeFilters > 0 ? " is-active" : ""}`}
                onClick={() => setSheetOpen(true)}
                aria-haspopup="dialog"
                aria-expanded={sheetOpen}
                aria-label={activeFilters > 0 ? `${filterTitle}, ${activeFilters} active` : filterTitle}
                title={filterTitle}
              >
                <SlidersHorizontal size={19} aria-hidden="true" />
                {activeFilters > 0 && <span className="mlc-badge" aria-hidden="true">{activeFilters}</span>}
              </button>
            )}
            <button
              ref={searchBtnRef}
              type="button"
              className={`mlc-fab${filtered ? " is-active" : ""}`}
              onClick={openSearch}
              aria-label={filtered ? `${searchLabel}, showing matches for "${query.trim()}"` : searchLabel}
              title={searchLabel}
            >
              <Search size={19} aria-hidden="true" />
              {filtered && <span className="mlc-dot" aria-hidden="true" />}
            </button>
          </div>
        )}
      </div>
      {sheetOpen && filters && (
        // Choices apply as they are made, like the app's menus, so there is no Done button: the
        // scrim, Escape or ✕ close it.
        <Modal title={filterTitle} className="modal--compact mlc-sheet" onClose={closeSheet}>
          <FocusInSheet />
          <div className="mlc-sheet-body">
            {filters}
            {onResetFilters && activeFilters > 0 && (
              <div className="mlc-menu">
                <button type="button" className="mlc-row" onClick={onResetFilters}>
                  <RotateCcw size={16} aria-hidden="true" />
                  <span className="mlc-row-label">Reset to defaults</span>
                </button>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

/** Moves focus into the sheet when it opens: to the sheet itself, so no control wears a focus ring on a tap. */
function FocusInSheet() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const panel = ref.current?.closest<HTMLElement>(".modal-panel");
    if (!panel) return;
    if (!panel.hasAttribute("tabindex")) panel.tabIndex = -1;
    panel.focus({ preventScroll: true });
  }, []);
  return <span ref={ref} hidden />;
}

/** A labelled group in the filter sheet. */
export function SheetSection({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <section className="mlc-sheet-section" aria-labelledby={id}>
      <h4 className="mlc-sheet-label" id={id}>{label}</h4>
      {children}
    </section>
  );
}

export interface SheetOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  /** A count shown after the label. */
  count?: number;
}

/**
 * One choice out of several (view, sort order, a kind filter), in the app's own controls: up to three
 * plain choices are the segmented control used across the app (`sop-diff-tabs`, as in the editor's
 * Write/Preview and the starter prompt tabs); longer lists, or ones with counts, are menu rows like the
 * sidebar and + menus, with a check on the chosen one.
 */
export function SheetOptions<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: SheetOption<T>[];
  onChange: (value: T) => void;
}) {
  const segmented = options.length <= 3 && options.every((o) => o.count === undefined);
  return (
    <SheetSection label={label}>
      {segmented ? (
        <div className="sop-diff-tabs mlc-segmented" role="radiogroup" aria-label={label}>
          {options.map((option) => {
            const Icon = option.icon;
            const checked = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={checked}
                className={`sop-diff-tab${checked ? " active" : ""}`}
                onClick={() => onChange(option.value)}
              >
                {Icon && <Icon size={15} aria-hidden="true" />}
                {option.label}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="mlc-menu" role="radiogroup" aria-label={label}>
          {options.map((option) => {
            const Icon = option.icon;
            const checked = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={checked}
                className={`mlc-row${checked ? " is-checked" : ""}`}
                onClick={() => onChange(option.value)}
              >
                {Icon && <Icon size={16} aria-hidden="true" />}
                <span className="mlc-row-label">{option.label}</span>
                {option.count !== undefined && <span className="mlc-row-count">{option.count}</span>}
                <Check size={16} className="mlc-row-check" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      )}
    </SheetSection>
  );
}

/** A button for a one-off action in the filter sheet (import, re-index, reconnect). */
export function SheetAction({
  icon: Icon,
  label,
  onClick,
  disabled,
  busy,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button type="button" className="mlc-row" onClick={onClick} disabled={disabled || busy}>
      <Icon size={16} aria-hidden="true" className={busy ? "spin" : undefined} />
      <span className="mlc-row-label">{label}</span>
    </button>
  );
}

/**
 * The pull-to-refresh indicator. Place it as the first thing inside the list's scroll container (or
 * anywhere at its top): it attaches to the nearest vertically scrolling ancestor. Phone width only.
 */
export function PullToRefresh({ onRefresh, disabled = false }: { onRefresh: () => unknown; disabled?: boolean }) {
  const isMobile = useIsMobile();
  const anchor = useRef<HTMLDivElement>(null);
  const { pull, phase, armed } = usePullToRefresh(anchor, onRefresh, isMobile && !disabled);
  if (!isMobile) return null;
  const progress = Math.min(1, pull / PULL_THRESHOLD);
  return (
    <div
      ref={anchor}
      className="ptr"
      data-phase={phase}
      data-armed={armed || undefined}
      style={{ "--ptr-pull": `${pull}px`, "--ptr-progress": progress } as React.CSSProperties}
      aria-hidden={phase === "idle" ? true : undefined}
    >
      <span className="ptr-badge">
        <RefreshCw size={16} className="ptr-icon" aria-hidden="true" />
      </span>
      <span className="mlc-sr-only" role="status">
        {phase === "refreshing" ? "Refreshing…" : ""}
      </span>
    </div>
  );
}
