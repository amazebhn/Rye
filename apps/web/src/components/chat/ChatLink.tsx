import { useEffect, useId, useRef, useState, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Globe, Play } from "lucide-react";

interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
  video?: string;
  videoType?: string;
  favicon?: string;
}

const OPEN_DELAY_MS = 350;
const CLOSE_DELAY_MS = 150;
const CARD_WIDTH = 320;
const CARD_GAP = 6;

const previews = new Map<string, Promise<LinkPreview | null>>();

function loadPreview(href: string): Promise<LinkPreview | null> {
  let p = previews.get(href);
  if (!p) {
    p = fetch(`/link-preview?url=${encodeURIComponent(href)}`)
      .then((r) => (r.ok ? (r.json() as Promise<LinkPreview>) : null))
      .catch(() => null);
    previews.set(href, p);
  }
  return p;
}

function webUrl(href: string | undefined): URL | null {
  if (!href) return null;
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

function shortUrl(u: URL): string {
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  return u.hostname.replace(/^www\./, "") + path;
}

const stripScheme = (s: string) => s.replace(/^https?:\/\//, "").replace(/\/$/, "");

function isPlayable(p: LinkPreview): boolean {
  if (!p.video) return false;
  return Boolean(p.videoType?.startsWith("video/")) || /\.(mp4|webm|mov|m4v)(\?|$)/i.test(p.video);
}

// Tries each source in order; later sources only show if earlier ones fail, so the icon doesn't swap.
function Favicon({ srcs }: { srcs: string[] | null }) {
  const [failed, setFailed] = useState(0);
  if (!srcs) return <span className="link-chip-icon" aria-hidden="true" />;
  const src = srcs[failed];
  if (!src) return <Globe className="link-chip-icon" size={12} aria-hidden="true" />;
  return (
    <img
      className="link-chip-icon"
      src={src}
      alt=""
      width={14}
      height={14}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed((n) => n + 1)}
    />
  );
}

function PreviewMedia({ preview }: { preview: LinkPreview }) {
  const [videoFailed, setVideoFailed] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (isPlayable(preview) && !videoFailed && !reduceMotion) {
    return (
      <div className="link-card-media">
        <video src={preview.video} poster={preview.image} muted autoPlay loop playsInline onError={() => setVideoFailed(true)} />
      </div>
    );
  }
  if (!preview.image || imageFailed) return null;
  return (
    <div className="link-card-media">
      <img src={preview.image} alt="" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} />
      {preview.video && (
        <span className="link-card-play" aria-hidden="true">
          <Play size={14} fill="currentColor" />
        </span>
      )}
    </div>
  );
}

type MarkdownLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { children?: ReactNode; node?: unknown };

// Markdown `a` renderer: web links become favicon chips with a hover preview.
export default function ChatLink({ children, href, node: _node, ...props }: MarkdownLinkProps) {
  const url = webUrl(href);
  if (!url) {
    return (
      <a {...props} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  return (
    <LinkChip {...props} url={url}>
      {children}
    </LinkChip>
  );
}

interface Placement {
  top: number;
  left: number;
  above: boolean;
}

function LinkChip({ url, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { url: URL; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Placement | null>(null);
  const [preview, setPreview] = useState<LinkPreview | null | undefined>(undefined);
  const [siteIcon, setSiteIcon] = useState<string | null | undefined>(undefined);
  const anchorRef = useRef<HTMLAnchorElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const cardId = useId();
  const origin = url.origin;

  // Only the origin's home page is fetched up front, so the full link isn't requested until hover.
  useEffect(() => {
    let live = true;
    void loadPreview(`${origin}/`).then((p) => {
      if (live) setSiteIcon(p?.favicon ?? null);
    });
    return () => {
      live = false;
    };
  }, [origin]);

  const measure = (): Placement | null => {
    const r = anchorRef.current?.getBoundingClientRect();
    if (!r || r.bottom < 0 || r.top > window.innerHeight) return null;
    const above = window.innerHeight - r.bottom < 320 && r.top > window.innerHeight - r.bottom;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - CARD_WIDTH - 8));
    return { left, top: above ? r.top - CARD_GAP : r.bottom + CARD_GAP, above };
  };

  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const next = measure();
      if (!next) return;
      setPlace(next);
      setOpen(true);
      void loadPreview(url.href).then(setPreview);
    }, OPEN_DELAY_MS);
  };

  const hide = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (!open) return;
    // The chat scrolls while streaming, so follow the link rather than closing.
    const follow = () => {
      const next = measure();
      if (next) setPlace(next);
      else setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const text = typeof children === "string" ? children : Array.isArray(children) && children.every((c) => typeof c === "string") ? children.join("") : null;
  const label = text !== null && stripScheme(text) === stripScheme(url.href) ? shortUrl(url) : children;
  const favicons =
    siteIcon === undefined
      ? null
      : [...new Set([siteIcon, `${origin}/favicon.ico`, preview?.favicon].filter((s): s is string => Boolean(s)))];
  const host = url.hostname.replace(/^www\./, "");

  return (
    <>
      <a
        {...props}
        ref={anchorRef}
        href={url.href}
        target="_blank"
        rel="noopener noreferrer"
        className="link-chip"
        aria-describedby={open ? cardId : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        <Favicon srcs={favicons} />
        <span className="link-chip-text">{label}</span>
      </a>
      {open &&
        place &&
        createPortal(
          <div
            id={cardId}
            role="tooltip"
            className={`link-card${place.above ? " link-card--above" : ""}`}
            style={{ top: place.top, left: place.left, width: CARD_WIDTH }}
            onMouseEnter={() => window.clearTimeout(timer.current)}
            onMouseLeave={hide}
          >
            <a className="link-card-body" href={url.href} target="_blank" rel="noopener noreferrer" tabIndex={-1}>
              {preview && <PreviewMedia preview={preview} />}
              <div className="link-card-text">
                <div className="link-card-site">
                  <Favicon srcs={favicons} />
                  <span>{preview?.siteName ?? host}</span>
                </div>
                {preview === undefined ? (
                  <div className="link-card-skeleton" aria-label="Loading preview" />
                ) : (
                  <>
                    {preview?.title && <div className="link-card-title">{preview.title}</div>}
                    {preview?.description && <div className="link-card-desc">{preview.description}</div>}
                  </>
                )}
                <div className="link-card-url">{shortUrl(url)}</div>
              </div>
            </a>
          </div>,
          document.body,
        )}
    </>
  );
}
