/**
 * ArtifactGrid — the shared renderer for a list of `ArtifactRef`s.
 *
 * Purpose: object arms render as compact document links through the chat's
 * context navigation, image arms as thumbnails in a responsive grid, and the
 * reserved `liveView` arm gets a full-width isolated iframe slot. Extracted
 * from `FormBlock` so ask_user interrupts and agent report cards render the same
 * artifacts identically. `isArtifactRef` admits untrusted artifact values.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ArtifactRef } from "@meridian/contracts/interrupt";
import { FileText } from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DocumentName } from "./DocumentName";

export function isArtifactRef(value: unknown): value is ArtifactRef {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "image" && typeof record.url === "string") {
    return (
      (record.mimeType === undefined || typeof record.mimeType === "string") &&
      (record.label === undefined || typeof record.label === "string")
    );
  }
  if (record.type === "object" && typeof record.uri === "string") {
    return (
      (record.label === undefined || typeof record.label === "string") &&
      (record.mimeType === undefined || typeof record.mimeType === "string")
    );
  }
  if (record.type === "liveView" && typeof record.url === "string") {
    return record.expiresAt === undefined || typeof record.expiresAt === "string";
  }
  return false;
}

export function ArtifactGrid({ artifacts }: { artifacts: ArtifactRef[] }) {
  // Documents read as compact links, images as thumbnails, and live views get
  // their own full-width slot.
  const documents = artifacts.filter(
    (artifact): artifact is Extract<ArtifactRef, { type: "object" }> => artifact.type === "object",
  );
  const images = artifacts.filter(
    (artifact): artifact is Extract<ArtifactRef, { type: "image" }> => artifact.type === "image",
  );
  const liveViews = artifacts.filter(
    (artifact): artifact is Extract<ArtifactRef, { type: "liveView" }> =>
      artifact.type === "liveView",
  );

  return (
    <div className="flex flex-col gap-[var(--chat-space-block)]">
      {documents.length > 0 ? (
        <ul className="flex flex-wrap gap-x-[var(--chat-space-block)] gap-y-[var(--chat-space-inline)] text-sm">
          {documents.map((artifact, index) => (
            <li key={artifactKey(artifact, index)} className="flex min-w-0 items-center gap-1.5">
              <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <DocumentName path={artifact.uri} />
            </li>
          ))}
        </ul>
      ) : null}
      {images.length > 0 ? (
        <ul className="grid grid-cols-2 gap-[var(--chat-space-block)] sm:grid-cols-3 lg:grid-cols-4">
          {images.map((artifact, index) => (
            <li key={artifactKey(artifact, index)}>
              <ImageArtifact image={artifact} />
            </li>
          ))}
        </ul>
      ) : null}
      {liveViews.map((artifact) => (
        <LiveViewSlot key={`live:${artifact.url}`} artifact={artifact} />
      ))}
    </div>
  );
}

function artifactKey(artifact: ArtifactRef, index: number): string {
  if (artifact.type === "image") return `${artifact.type}:${artifact.url}:${index}`;
  if (artifact.type === "object") return `${artifact.type}:${artifact.uri}:${index}`;
  return `${artifact.type}:${index}`;
}

function ImageArtifact({ image }: { image: Extract<ArtifactRef, { type: "image" }> }) {
  const label = image.label ?? t`Image artifact`;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="focus-ring group block w-full overflow-hidden rounded-md border border-border-subtle bg-muted transition-all hover:border-border-focus"
        >
          <img
            src={image.url}
            alt={label}
            className="aspect-square w-full object-cover transition-transform group-hover:scale-105"
            loading="lazy"
          />
          {image.label ? (
            <span className="block truncate px-[var(--chat-space-block)] py-[var(--chat-space-inline)] text-foreground text-xs">
              {image.label}
            </span>
          ) : null}
        </button>
      </DialogTrigger>
      <DialogContent className="text-tier-chat max-w-3xl">
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <DialogClose asChild>
          <button
            type="button"
            className="focus-ring block w-full overflow-hidden rounded-md"
            aria-label={t`Close artifact preview`}
          >
            <img src={image.url} alt={label} className="h-auto w-full" />
          </button>
        </DialogClose>
        {image.label ? (
          <p className="mt-[var(--chat-space-block)] text-muted-foreground text-sm">
            {image.label}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function LiveViewSlot({ artifact }: { artifact: Extract<ArtifactRef, { type: "liveView" }> }) {
  // Isolated iframe per execution-model §8.4: the URL is a live-preview
  // link to a viewer. `allow-scripts`
  // is required for the viewer JS; `allow-same-origin` keeps the preview
  // proxy's auth cookie usable. Nothing produces liveView arms today —
  // this slot is the contract landing zone.
  return (
    <div className="overflow-hidden rounded-md border border-border-subtle bg-muted">
      <div className="flex items-center justify-between border-border-subtle border-b px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)]">
        <span className="font-medium text-foreground text-xs uppercase tracking-wide">
          <Trans>Live view</Trans>
        </span>
        {artifact.expiresAt ? (
          <span className="text-muted-foreground text-xs">
            <Trans>expires {artifact.expiresAt}</Trans>
          </span>
        ) : null}
      </div>
      <iframe
        title={t`Live artifact view`}
        src={artifact.url}
        sandbox="allow-scripts allow-same-origin"
        className="block aspect-video w-full"
      />
    </div>
  );
}
