import React from "react";
import { LayoutGrid, List, Search, type LucideIcon } from "lucide-react";
import MobileListControls, { PullToRefresh, SheetOptions } from "../shared/MobileListControls";
import { useIsMobile } from "../../utils/viewport";

export type SettingsListView = "list" | "card";

interface Props {
  /** Id of the title, for the section's `aria-labelledby`. */
  id: string;
  title: string;
  /** One short sentence: it should fit on one line, so the toolbar below starts at the same height on every page. */
  description: React.ReactNode;
  query: string;
  onQueryChange: (query: string) => void;
  searchPlaceholder: string;
  searchLabel: string;
  view: SettingsListView;
  onViewChange: (view: SettingsListView) => void;
  /** Turns the search field and the view toggle off, for a page with nothing to list yet. */
  disabled?: boolean;
  /** Small icon buttons (refresh, import…) set just before the primary button. */
  actions?: React.ReactNode;
  /** Left out on a page that only shows things (Tools): its `actions` then end the row. */
  primary?: { label: string; icon: LucideIcon; onClick?: () => void; disabled?: boolean; title?: string };
  /**
   * Phone width (MobileListControls): the toolbar gives way to floating search and filter buttons. The
   * filter sheet holds the view toggle, then these (a page's filters and the actions it had in `actions`).
   */
  mobileFilters?: React.ReactNode;
  /** Filters changed from their defaults, for the filter button's badge. */
  mobileActiveFilters?: number;
  onResetFilters?: () => void;
  /** What pulling the list down does on a phone (re-fetch). Left out, the page has no pull to refresh. */
  onRefresh?: () => unknown;
  /** Hides the floating controls, e.g. while an opened item covers the page. */
  mobileHidden?: boolean;
}

/**
 * The heading and toolbar of a Settings page that lists things (Skills, MCP servers, Integrations).
 * Every such page uses this so the title, the search field, the list/grid toggle and the primary
 * button sit in exactly the same place on each, and switching pages doesn't move them.
 *
 * The heading has a row of its own and the toolbar sits under it: search and view toggle on the
 * left, a page's own actions and the primary button on the right. Neither row's layout depends on
 * how many actions a page has or how long its description is.
 */
export default function SettingsListHeader({
  id,
  title,
  description,
  query,
  onQueryChange,
  searchPlaceholder,
  searchLabel,
  view,
  onViewChange,
  disabled = false,
  actions,
  primary,
  mobileFilters,
  mobileActiveFilters = 0,
  onResetFilters,
  onRefresh,
  mobileHidden = false,
}: Props) {
  const PrimaryIcon = primary?.icon;
  const isMobile = useIsMobile();

  // Phone width: the heading and the primary button share a row (the pill row above is the page's top
  // bar); search, the view toggle and the page's actions float at the bottom (MobileListControls).
  if (isMobile) {
    return (
      <div className="settings-list-bar">
        {onRefresh && !disabled && <PullToRefresh onRefresh={onRefresh} />}
        <div className="settings-list-head-row">
          <div className="settings-section-head">
            <h3 className="settings-section-title" id={id}>{title}</h3>
            <p className="settings-section-desc">{description}</p>
          </div>
          {primary && PrimaryIcon && (
            <button
              type="button"
              className="sop-new-btn settings-list-primary mlc-primary"
              onClick={primary.onClick}
              disabled={primary.disabled}
              title={primary.title}
            >
              <PrimaryIcon size={15} aria-hidden="true" />
              {primary.label}
            </button>
          )}
        </div>
        {!disabled && (
          <MobileListControls
            query={query}
            onQueryChange={onQueryChange}
            searchLabel={searchLabel}
            searchPlaceholder={searchPlaceholder}
            filters={
              <>
                <SheetOptions
                  label="View"
                  value={view}
                  onChange={onViewChange}
                  options={[
                    { value: "list", label: "List", icon: List },
                    { value: "card", label: "Grid", icon: LayoutGrid },
                  ]}
                />
                {mobileFilters}
              </>
            }
            activeFilters={mobileActiveFilters}
            onResetFilters={onResetFilters}
            hidden={mobileHidden}
          />
        )}
      </div>
    );
  }

  return (
    <div className="settings-list-bar">
      <div className="settings-section-head">
        <h3 className="settings-section-title" id={id}>{title}</h3>
        <p className="settings-section-desc">{description}</p>
      </div>
      <div className="settings-list-toolbar">
        <div className="sop-search-wrap settings-list-search">
          <Search size={13} className="sop-search-icon" aria-hidden="true" />
          <input
            className="sop-search-input"
            placeholder={searchPlaceholder}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            aria-label={searchLabel}
            disabled={disabled}
          />
        </div>
        <div className="settings-list-views" role="group" aria-label="View">
          {([["list", List, "List view"], ["card", LayoutGrid, "Grid view"]] as const).map(([mode, Icon, label]) => (
            <button
              key={mode}
              type="button"
              className={`icon-btn sop-view-btn${view === mode ? " active" : " faint"}`}
              onClick={() => onViewChange(mode)}
              aria-pressed={view === mode}
              aria-label={label}
              title={label}
              disabled={disabled}
            >
              <Icon size={14} />
            </button>
          ))}
        </div>
        <div className="settings-list-actions">
          {actions}
          {primary && PrimaryIcon && (
            <button
              type="button"
              className="sop-new-btn settings-list-primary"
              onClick={primary.onClick}
              disabled={primary.disabled}
              title={primary.title}
            >
              <PrimaryIcon size={13} aria-hidden="true" />
              {primary.label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
