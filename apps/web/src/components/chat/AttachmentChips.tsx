import React, { useId } from "react";
import { BookOpen, FileText, LoaderCircle, TextQuote, TriangleAlert, Wrench, X } from "lucide-react";
import {
  attachmentUrl,
  formatBytes,
  quoteSnippet,
  quoteTitle,
  refKey,
  type AttachmentRef,
  type ContextRef,
  type PendingAttachment,
  type QuoteContextRef,
} from "../../utils/attachments";

type Item =
  | { kind: "pending"; item: PendingAttachment }
  | { kind: "sent"; item: AttachmentRef };

function detail(ref: AttachmentRef | undefined, size: number): string {
  if (ref?.kind === "pdf") return `PDF${ref.pages ? ` · ${ref.pages} page${ref.pages === 1 ? "" : "s"}` : ""} · ${formatBytes(size)}`;
  return formatBytes(size);
}

/**
 * A quote (text selected somewhere and added to the chat) as a slim one-line pill: a small quote
 * icon, then "fingerprint.js · L12–18" ("· old" for an old-side diff quote), or the source ("Rye's
 * reply") and the excerpt's first words; × on the right in the composer. Hovering or focusing it
 * shows the whole excerpt in a card (mono for code), headed "fingerprint.js · lines 12–18 · new".
 */
function QuoteChip({ quote, onRemove }: { quote: QuoteContextRef; onRemove?: () => void }) {
  const tipId = useId();
  const { source } = quote;
  const lines = source.lines;
  const label = lines ? `${quoteTitle(quote)}${source.side === "old" ? " · old" : ""}` : source.label;
  const snippet = lines ? "" : quoteSnippet(quote.text, 24);
  const name = snippet ? `${label}: ${snippet}` : label;
  const code = source.kind === "diff" || Boolean(source.path);
  const head = [
    source.path ?? source.label,
    lines ? (lines.start === lines.end ? `line ${lines.start}` : `lines ${lines.start}–${lines.end}`) : "",
    source.side ?? "",
  ].filter(Boolean).join(" · ");
  return (
    <li className="attachment-chip is-quote">
      <span className="quote-pill">
        <span className="quote-pill-main" tabIndex={0} aria-describedby={tipId} aria-label={`Quote: ${name}`}>
          <TextQuote size={14} className="quote-pill-icon" aria-hidden="true" />
          <span className="quote-pill-label">{label}</span>
          {snippet && <span className="quote-pill-snippet">{snippet}</span>}
        </span>
        {onRemove && (
          <button type="button" className="quote-pill-remove" onClick={onRemove} aria-label={`Remove quote ${name}`} title="Remove">
            <X size={12} />
          </button>
        )}
      </span>
      <span id={tipId} role="tooltip" className="attachment-quote-pop">
        <span className="attachment-quote-pop-head">{head}</span>
        <span className={`attachment-quote-pop-text${code ? " is-code" : ""}`}>{quote.text}</span>
      </span>
    </li>
  );
}

/**
 * Files on a message: in the composer (with upload state and a remove button) or on a sent
 * message (each opens the file in a new tab). Images show as thumbnails, other files as chips.
 */
export default function AttachmentChips({
  pending,
  sent,
  onRemove,
  refs,
  onRemoveRef,
  className = "",
}: {
  pending?: PendingAttachment[];
  sent?: AttachmentRef[];
  onRemove?: (key: string) => void;
  /** SOPs and tools the message is pointed at. */
  refs?: ContextRef[];
  onRemoveRef?: (key: string) => void;
  className?: string;
}) {
  const items: Item[] = [
    ...(pending ?? []).map((item) => ({ kind: "pending" as const, item })),
    ...(sent ?? []).map((item) => ({ kind: "sent" as const, item })),
  ];
  if (items.length === 0 && !refs?.length) return null;

  return (
    <ul className={`attachment-chips ${className}`} aria-label="Attached to this message">
      {(refs ?? []).map((ref) => {
        const key = refKey(ref);
        if (ref.type === "quote") return <QuoteChip key={key} quote={ref} onRemove={onRemoveRef ? () => onRemoveRef(key) : undefined} />;
        const label = ref.type === "sop" ? ref.title : ref.name;
        return (
          <li key={key} className="attachment-chip" title={ref.type === "sop" ? `SOP: ${ref.title}` : `Tool: ${ref.name}`}>
            <span className="attachment-file">
              <span className="attachment-file-icon" aria-hidden="true">
                {ref.type === "sop" ? <BookOpen size={15} /> : <Wrench size={15} />}
              </span>
              <span className="attachment-file-text">
                <span className={`attachment-file-name${ref.type === "tool" ? " is-code" : ""}`}>{label}</span>
                <span className="attachment-file-detail">{ref.type === "sop" ? "SOP to follow" : "Tool to use"}</span>
              </span>
            </span>
            {onRemoveRef && (
              <button type="button" className="attachment-remove" onClick={() => onRemoveRef(key)} aria-label={`Remove ${label}`} title="Remove">
                <X size={12} />
              </button>
            )}
          </li>
        );
      })}
      {items.map((entry) => {
        const ref = entry.kind === "sent" ? entry.item : entry.item.ref;
        const name = entry.item.name;
        const size = entry.item.size;
        const status = entry.kind === "pending" ? entry.item.status : "ready";
        const isImage = ref ? ref.kind === "image" : Boolean(entry.kind === "pending" && entry.item.previewUrl);
        const preview = entry.kind === "pending" ? entry.item.previewUrl : undefined;
        const src = preview ?? (ref ? attachmentUrl(ref.id) : undefined);
        const key = entry.kind === "pending" ? entry.item.key : entry.item.id;
        const error = entry.kind === "pending" ? entry.item.error : undefined;

        const body = isImage && src ? (
          <span className="attachment-thumb">
            <img src={src} alt={name} loading="lazy" />
            {status === "uploading" && <span className="attachment-thumb-busy"><LoaderCircle size={16} className="spin" aria-hidden="true" /></span>}
          </span>
        ) : (
          <span className="attachment-file">
            <span className="attachment-file-icon" aria-hidden="true">
              {status === "uploading" ? <LoaderCircle size={15} className="spin" /> : status === "error" ? <TriangleAlert size={15} /> : <FileText size={15} />}
            </span>
            <span className="attachment-file-text">
              <span className="attachment-file-name">{name}</span>
              <span className="attachment-file-detail">{error ?? (status === "uploading" ? "Uploading…" : detail(ref, size))}</span>
            </span>
          </span>
        );

        return (
          <li key={key} className={`attachment-chip${isImage ? " is-image" : ""}${status === "error" ? " is-error" : ""}`} title={error ?? name}>
            {ref && status === "ready" ? (
              <a href={attachmentUrl(ref.id)} target="_blank" rel="noreferrer" className="attachment-open" aria-label={`Open ${name}`}>
                {body}
              </a>
            ) : (
              body
            )}
            {onRemove && entry.kind === "pending" && (
              <button type="button" className="attachment-remove" onClick={() => onRemove(entry.item.key)} aria-label={`Remove ${name}`} title="Remove">
                <X size={12} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
