/**
 * The chip row: a preview of what the draft is sending, derived entirely from
 * the doc's upload tokens — chips are what you're sending, the text is what
 * you're saying. No chip owns any state; every fact it shows (thumbnail,
 * name, size, lifecycle) is read off a token, and its two controls go back
 * through the doc: × removes the token (the same detach backspace performs),
 * retry re-runs the token's upload. Facts separate by layout, never glyphs
 * (writer-copy ruling).
 */

import { t } from "@lingui/core/macro";
import { apiDocumentDownloadPath } from "@meridian/contracts/protocol";
import { FileText, Loader2, RotateCw, X } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

import type { ComposerUploadToken } from "./composer-attachments";

export function ComposerAttachmentChips({
  tokens,
  onRemove,
  onRetry,
}: {
  tokens: ComposerUploadToken[];
  onRemove: (uploadId: string) => void;
  onRetry: (uploadId: string) => void;
}) {
  if (tokens.length === 0) return null;
  return (
    <ul aria-label={t`Attachments`} className="mb-2 flex flex-wrap gap-2 px-1.5">
      {tokens.map((token) => (
        <AttachmentChip
          key={token.upload.id}
          token={token}
          onRemove={() => onRemove(token.upload.id)}
          onRetry={() => onRetry(token.upload.id)}
        />
      ))}
    </ul>
  );
}

function AttachmentChip({
  token,
  onRemove,
  onRetry,
}: {
  token: ComposerUploadToken;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const { upload } = token;
  const failed = upload.state === "failed";
  const uploading = upload.state === "uploading";
  return (
    <li
      className={cn(
        "flex items-center gap-2 rounded-md border bg-muted/40 p-1 pr-1.5",
        failed ? "border-destructive" : "border-border-subtle",
      )}
    >
      <ChipThumbnail token={token} />
      <span className="flex min-w-0 flex-col">
        <span className="max-w-40 truncate text-foreground text-xs" title={token.label}>
          {token.label}
        </span>
        <span className={cn("text-meta", failed ? "text-destructive" : "text-muted-foreground")}>
          {failed ? t`Upload failed` : uploading ? t`Uploading` : formatSize(upload.sizeBytes)}
        </span>
      </span>
      {failed ? (
        <ChipControl label={t`Retry uploading ${token.label}`} onClick={onRetry}>
          <RotateCw aria-hidden className="size-3.5" />
        </ChipControl>
      ) : null}
      <ChipControl label={t`Remove ${token.label}`} onClick={onRemove}>
        <X aria-hidden className="size-3.5" />
      </ChipControl>
    </li>
  );
}

function ChipControl({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

/**
 * Images get their pixels (the paste-time object URL, falling back to the
 * server's download once a documentId exists); everything else gets the
 * generic file glyph. While uploading, a quiet spinner rides over the slot.
 */
function ChipThumbnail({ token }: { token: ComposerUploadToken }) {
  const { upload } = token;
  const [broken, setBroken] = useState(false);
  const uploading = upload.state === "uploading";
  const src =
    upload.previewUrl || (token.documentId ? apiDocumentDownloadPath(token.documentId) : "");
  const showImage = upload.mimeType.startsWith("image/") && src !== "" && !broken;
  return (
    <span className="relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted">
      {showImage ? (
        <img src={src} alt="" className="size-full object-cover" onError={() => setBroken(true)} />
      ) : (
        <FileText aria-hidden className="size-4 text-muted-foreground" />
      )}
      {uploading ? (
        <span className="absolute inset-0 flex items-center justify-center bg-background/60">
          <Loader2 aria-hidden className="size-4 animate-spin text-foreground" />
        </span>
      ) : null}
    </span>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return t`${bytes} B`;
  if (bytes < 1024 * 1024) return t`${(bytes / 1024).toFixed(1)} KB`;
  return t`${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
