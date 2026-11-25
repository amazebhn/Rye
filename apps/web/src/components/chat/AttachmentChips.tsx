import React from "react";
import { BookOpen, FileText, LoaderCircle, TriangleAlert, Wrench, X } from "lucide-react";
import { attachmentUrl, formatBytes, refKey, type AttachmentRef, type ContextRef, type PendingAttachment } from "../../utils/attachments";

type Item =
  | { kind: "pending"; item: PendingAttachment }
  | { kind: "sent"; item: AttachmentRef };

function detail(ref: AttachmentRef | undefined, size: number): string {
  if (ref?.kind === "pdf") return `PDF${ref.pages ? ` · ${ref.pages} page${ref.pages === 1 ? "" : "s"}` : ""} · ${formatBytes(size)}`;
  return formatBytes(size);
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
