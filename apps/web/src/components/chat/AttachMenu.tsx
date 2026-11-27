import React, { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, ChevronRight, Info, Paperclip, Plus, Search, Wrench } from "lucide-react";
import { ATTACHMENT_ACCEPT, refKey, type ContextRef } from "../../utils/attachments";
import { openAppPath, sopPath, toolPath } from "../../utils/routes";

interface SopRow { id: number; title: string; description?: string }
interface ToolGroupRow { id: string; title?: string; description: string; tools: Array<{ name: string; title?: string; description: string }> }

type Kind = "sop" | "tool";

const POPOUT_WIDTH = 360;
const POPOUT_MAX_HEIGHT = 380;

/** The last few SOPs or tools picked, newest first, kept in this browser. */
const RECENT_LIMIT = 4;
const recentKey = (kind: Kind) => `rye-recent-${kind}s`;

function readRecentRefs(kind: Kind): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(recentKey(kind)) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string").slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

function recordRecentRef(kind: Kind, key: string): void {
  try {
    const next = [key, ...readRecentRefs(kind).filter((k) => k !== key)].slice(0, RECENT_LIMIT);
    window.localStorage.setItem(recentKey(kind), JSON.stringify(next));
  } catch {
    // Private mode or storage full: recents just aren't remembered.
  }
}

/**
 * The composer's "+" button: a small menu of things to add to a message. "Upload files" opens
 * the file picker; "Use an SOP" and "Use a tool" open a searchable list beside the menu
 * (on hover, click, Enter or →). More entries go in the same menu.
 */
export default function AttachMenu({
  onFiles,
  onRef,
  picked = [],
  disabled = false,
}: {
  onFiles: (files: File[]) => void;
  onRef?: (ref: ContextRef) => void;
  /** Already on the message, so marked in the lists. */
  picked?: ContextRef[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  /** Where the list sits: its top edge level with the menu's top, or (no room below) its bottom level with the menu's bottom. */
  const [popout, setPopout] = useState<
    { kind: Kind; left: number; width: number; focus: boolean; maxHeight: number } & ({ top: number } | { bottom: number })
  | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const popoutRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  const close = (focusButton = false) => {
    window.clearTimeout(closeTimer.current);
    setOpen(false);
    setPopout(null);
    if (focusButton) buttonRef.current?.focus();
  };

  const triggerOf = (kind: Kind) => menuRef.current?.querySelector<HTMLButtonElement>(`[data-popout="${kind}"]`) ?? null;

  /** Open a list beside its menu item; `focus` moves the caret into its search (keyboard or click). */
  const openPopout = (kind: Kind, focus: boolean) => {
    window.clearTimeout(closeTimer.current);
    const trigger = triggerOf(kind);
    if (!trigger) return;
    const menu = menuRef.current?.getBoundingClientRect() ?? trigger.getBoundingClientRect();
    const gap = 6;
    const fitsRight = menu.right + gap + POPOUT_WIDTH <= window.innerWidth - 8;
    const fitsLeft = menu.left - gap - POPOUT_WIDTH >= 8;
    // No room beside the menu (a phone): the list is a sheet over the menu, the window's width less a
    // small margin, its bottom level with the menu's so it grows upward from the composer.
    if (!fitsRight && !fitsLeft) {
      const sheet = {
        kind,
        focus,
        left: 8,
        width: window.innerWidth - 16,
        bottom: window.innerHeight - menu.bottom,
        maxHeight: Math.min(POPOUT_MAX_HEIGHT, menu.bottom - 8),
      };
      setPopout((current) => (current?.kind === kind && !focus ? current : sheet));
      return;
    }
    const left = fitsRight ? menu.right + gap : menu.left - POPOUT_WIDTH - gap;
    // Align an edge with the menu's: tops when the full list fits below, otherwise bottoms (anchored from
    // the bottom, so it stays aligned as the list loads or filters and grows upward). The menu opens
    // upward from the composer, so it is usually bottoms.
    const roomBelow = window.innerHeight - 8 - menu.top;
    const placement = roomBelow >= POPOUT_MAX_HEIGHT
      ? { top: menu.top, maxHeight: POPOUT_MAX_HEIGHT }
      : { bottom: window.innerHeight - menu.bottom, maxHeight: Math.min(POPOUT_MAX_HEIGHT, menu.bottom - 8) };
    setPopout((current) => (current?.kind === kind && !focus ? current : { kind, left, width: POPOUT_WIDTH, focus, ...placement }));
  };

  /** Close the list shortly, unless the pointer comes back or the search has the caret. */
  const scheduleClosePopout = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      if (popoutRef.current?.contains(document.activeElement)) return;
      setPopout(null);
    }, 220);
  };

  const backToMenu = () => {
    const kind = popout?.kind;
    setPopout(null);
    if (kind) triggerOf(kind)?.focus();
  };

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  useEffect(() => {
    if (!open) return;
    if (!popout) menuRef.current?.querySelector<HTMLButtonElement>(".attach-menu-item")?.focus();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target) || popoutRef.current?.contains(target)) return;
      close();
    };
    const onResize = () => close();
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onResize);
    };
    // Only on opening: focus stays wherever the user moves it while the menu is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (popout?.focus) searchRef.current?.focus();
  }, [popout]);

  const menuKeys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>(".attach-menu-item") ?? []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const kind = (document.activeElement as HTMLElement | null)?.dataset?.popout as Kind | undefined;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
      next?.focus();
      const nextKind = next?.dataset.popout as Kind | undefined;
      if (nextKind) openPopout(nextKind, false);
      else setPopout(null);
    } else if (e.key === "ArrowRight" && kind) {
      e.preventDefault();
      openPopout(kind, true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (popout && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Typing while a list is open searches it.
      searchRef.current?.focus();
    }
  };

  const pick = (ref: ContextRef) => {
    onRef?.(ref);
    close(true);
  };

  return (
    <div className="attach-menu" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`attach-menu-btn${open ? " is-open" : ""}`}
        onClick={() => (open ? close() : setOpen(true))}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Add to message"
        title="Add files, an SOP or a tool"
      >
        <Plus size={15} strokeWidth={2.25} />
      </button>
      {open && (
        <div className="attach-menu-pop" role="menu" aria-label="Add to message" ref={menuRef} onKeyDown={menuKeys}>
          <button
            type="button"
            role="menuitem"
            className="attach-menu-item"
            onMouseEnter={(e) => { e.currentTarget.focus(); setPopout(null); }}
            onFocus={() => setPopout(null)}
            onClick={() => {
              close();
              fileRef.current?.click();
            }}
          >
            <Paperclip size={17} aria-hidden="true" />
            <span className="attach-menu-item-text">
              <span>Upload files</span>
              <span className="attach-sr-only">: images, PDFs and text files</span>
            </span>
          </button>
          {onRef && (
            <div className="attach-menu-section" role="presentation" aria-hidden="true">Use</div>
          )}
          {onRef &&
            ([
              ["sop", BookOpen, "SOP", "Have Rye follow a runbook", "Use an SOP"],
              ["tool", Wrench, "Tool", "Point Rye at a specific tool", "Use a tool"],
            ] as const).map(([kind, Icon, label, hint, spoken]) => (
              <button
                key={kind}
                type="button"
                role="menuitem"
                data-popout={kind}
                aria-haspopup="listbox"
                aria-label={`${spoken}: ${hint}`}
                aria-expanded={popout?.kind === kind}
                className={`attach-menu-item attach-menu-item--popout${popout?.kind === kind ? " is-open" : ""}`}
                onMouseEnter={(e) => {
                  // One highlight for mouse and keyboard: the hovered item takes focus.
                  if (!popoutRef.current?.contains(document.activeElement)) e.currentTarget.focus();
                  openPopout(kind, false);
                }}
                onMouseLeave={scheduleClosePopout}
                onClick={() => openPopout(kind, true)}
              >
                <Icon size={17} aria-hidden="true" />
                <span className="attach-menu-item-text">
                  <span>{label}</span>
                </span>
                <ChevronRight size={16} className="attach-menu-item-chevron" aria-hidden="true" />
              </button>
            ))}
        </div>
      )}
      {open && popout && (
        <div
          ref={popoutRef}
          className="attach-popout"
          style={{
            ...("top" in popout ? { top: popout.top } : { bottom: popout.bottom }),
            left: popout.left,
            width: popout.width,
            maxHeight: popout.maxHeight,
          }}
          onMouseEnter={() => window.clearTimeout(closeTimer.current)}
          onMouseLeave={scheduleClosePopout}
        >
          <Picker
            key={popout.kind}
            kind={popout.kind}
            picked={picked}
            onPick={pick}
            onBack={backToMenu}
            onOpenDetails={(path) => {
              close();
              openAppPath(path);
            }}
            searchRef={searchRef}
          />
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // Reset so picking the same file again still fires.
          e.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
    </div>
  );
}

interface Option {
  /** An SOP or a tool (quotes come from text selections, not from this menu). */
  ref: Exclude<ContextRef, { type: "quote" }>;
  label: string;
  /** A tool's code name, shown small after its title. */
  sub?: string;
  detail: string;
  section?: string;
}

/** A searchable list of SOPs or tools. */
function Picker({
  kind,
  picked,
  onPick,
  onBack,
  onOpenDetails,
  searchRef,
}: {
  kind: Kind;
  picked: ContextRef[];
  onPick: (ref: ContextRef) => void;
  onBack: () => void;
  /** Open an SOP's or tool's own page (the ⓘ). */
  onOpenDetails: (path: string) => void;
  searchRef: React.RefObject<HTMLInputElement>;
}) {
  const [options, setOptions] = useState<Option[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const pickedKeys = useMemo(() => new Set(picked.map(refKey)), [picked]);

  useEffect(() => {
    let live = true;
    const load = kind === "sop"
      ? fetch("/sop/").then((r) => r.json()).then((rows: SopRow[]) =>
          rows.map((s): Option => ({ ref: { type: "sop", id: s.id, title: s.title }, label: s.title, detail: s.description ?? "" })),
        )
      : fetch("/chat/tools").then((r) => r.json()).then((data: { groups: ToolGroupRow[] }) =>
          data.groups.flatMap((g) =>
            g.tools.map((t): Option => ({
              ref: { type: "tool", name: t.name, group: g.id },
              label: t.title ?? t.name,
              ...(t.title ? { sub: t.name } : {}),
              detail: t.description,
              section: g.title ?? g.id,
            })),
          ),
        );
    load
      .then((rows) => { if (live) setOptions(rows); })
      .catch(() => { if (live) setError(kind === "sop" ? "Couldn't load SOPs." : "Couldn't load tools."); });
    return () => { live = false; };
  }, [kind]);

  // The last few picked, kept in this browser, shown first (like recent models in the model picker).
  const [recent] = useState(() => readRecentRefs(kind));

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!options) return [];
    if (q) return options.filter((o) => `${o.label} ${o.sub ?? ""} ${o.detail} ${o.section ?? ""}`.toLowerCase().includes(q));
    const byKey = new Map(options.map((o) => [refKey(o.ref), o]));
    const recentOptions = recent.flatMap((key) => {
      const o = byKey.get(key);
      return o ? [{ ...o, section: "Recent" }] : [];
    });
    if (recentOptions.length === 0) return options;
    const recentKeys = new Set(recentOptions.map((o) => refKey(o.ref)));
    // Not listed twice; SOPs have no groups of their own, so the rest gets a heading.
    const rest = options
      .filter((o) => !recentKeys.has(refKey(o.ref)))
      .map((o) => (o.section ? o : { ...o, section: "All SOPs" }));
    return [...recentOptions, ...rest];
  }, [options, query, recent]);

  // Only the arrow keys scroll the list to the highlighted row; the pointer moving over rows must not.
  const scrollToActive = useRef(false);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (!scrollToActive.current) return;
    scrollToActive.current = false;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (ref: ContextRef) => {
    recordRecentRef(kind, refKey(ref));
    onPick(ref);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length === 0) return;
      scrollToActive.current = true;
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const option = shown[active];
      if (option && !pickedKeys.has(refKey(option.ref))) choose(option.ref);
    } else if (e.key === "Escape" || (e.key === "ArrowLeft" && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0)) {
      // Back to the menu (a second Escape there closes it).
      e.preventDefault();
      e.stopPropagation();
      onBack();
    }
  };

  const noun = kind === "sop" ? "SOP" : "tool";
  let lastSection: string | undefined;

  return (
    <div className="attach-picker" role="dialog" aria-label={kind === "sop" ? "Choose an SOP" : "Choose a tool"}>
      <div className="attach-picker-search">
        <Search size={13} aria-hidden="true" />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder={kind === "sop" ? "Search SOPs…" : "Search tools…"}
          aria-label={kind === "sop" ? "Search SOPs" : "Search tools"}
          aria-controls={`attach-picker-list-${kind}`}
          aria-activedescendant={shown[active] ? `attach-picker-${kind}-${active}` : undefined}
        />
      </div>
      {error ? (
        <p className="attach-picker-empty" role="alert">{error}</p>
      ) : options === null ? (
        <p className="attach-picker-empty">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="attach-picker-empty">{options.length === 0 ? (kind === "sop" ? "No SOPs yet. Create one from the SOPs page." : "No tools available.") : `No ${noun} matches "${query.trim()}".`}</p>
      ) : (
        <ul className="attach-picker-list" id={`attach-picker-list-${kind}`} role="listbox" ref={listRef}>
          {shown.map((o, i) => {
            const heading = o.section && o.section !== lastSection ? o.section : null;
            lastSection = o.section;
            const already = pickedKeys.has(refKey(o.ref));
            return (
              <React.Fragment key={refKey(o.ref)}>
                {heading && <li className="attach-picker-section" role="presentation">{heading}</li>}
                <li
                  id={`attach-picker-${kind}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={already}
                  className={`attach-picker-option${i === active ? " is-active" : ""}${already ? " is-picked" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (!already) choose(o.ref);
                  }}
                >
                  <span className={`attach-picker-label${kind === "tool" && !o.sub ? " is-code" : ""}`}>{o.label}</span>
                  {/* The code name isn't shown (it squeezed titles); it is still searchable, and on the tool's ⓘ page. */}
                  {o.detail && <span className="attach-sr-only">{`: ${o.detail}`}</span>}
                  {already && <span className="attach-picker-picked">Added</span>}
                  {/* Details live on its own page (Settings → Tools, or the SOP), not in this list. */}
                  <a
                    className="attach-picker-info"
                    href={o.ref.type === "sop" ? sopPath(o.ref.id) : toolPath(o.ref.name)}
                    aria-label={`About ${o.label}`}
                    title={`About ${o.label}`}
                    tabIndex={i === active ? 0 : -1}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onOpenDetails(o.ref.type === "sop" ? sopPath(o.ref.id) : toolPath(o.ref.name));
                    }}
                  >
                    <Info size={14} aria-hidden="true" />
                  </a>
                </li>
              </React.Fragment>
            );
          })}
        </ul>
      )}
    </div>
  );
}
