/**
 * ArtifactGrid — the shared renderer for a list of `ArtifactRef`s.
 *
 * Purpose: image and object arms render as thumbnails in a responsive grid;
 * the reserved `liveView` arm gets a full-width isolated iframe slot. Extracted
 * from `FormBlock` so ask_user interrupts and agent report cards render the same
 * artifacts identically. `isArtifactRef` is the boundary guard for artifact
 * arrays whose persisted shape is unvalidated.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ArtifactRef } from "@meridian/contracts/interrupt";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function isArtifactRef(value: unknown): value is ArtifactRef {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "image" && typeof record.url === "string") return true;
  if (record.type === "object" && typeof record.uri === "string") return true;
  if (record.type === "liveView" && typeof record.url === "string") return true;
  return false;
}

export function ArtifactGrid({ artifacts }: { artifacts: ArtifactRef[] }) {
  // Live-view arms get a dedicated row spanning the grid; image + object
  // thumbnails share the responsive grid.
  const liveViews = artifacts.filter(
    (artifact): artifact is Extract<ArtifactRef, { type: "liveView" }> =>
      artifact.type === "liveView",
  );
  const thumbs = artifacts.filter((artifact) => artifact.type !== "liveView");

  return (
    <div className="flex flex-col gap-3">
      {thumbs.length > 0 ? (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {thumbs.map((artifact, index) => (
            <li key={artifactKey(artifact, index)}>
              <ArtifactThumb artifact={artifact} />
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

function ArtifactThumb({
  artifact,
}: {
  artifact: Extract<ArtifactRef, { type: "image" | "object" }>;
}) {
  if (artifact.type === "image") {
    return <ImageArtifact image={artifact} />;
  }
  return <ObjectArtifact object={artifact} />;
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
            <span className="block truncate px-2 py-1 text-foreground text-xs">{image.label}</span>
          ) : null}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
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
        {image.label ? <p className="mt-2 text-muted-foreground text-sm">{image.label}</p> : null}
      </DialogContent>
    </Dialog>
  );
}

function ObjectArtifact({ object }: { object: Extract<ArtifactRef, { type: "object" }> }) {
  const label = object.label ?? object.uri;
  return (
    <a
      href={object.uri}
      target="_blank"
      rel="noreferrer"
      className="focus-ring flex h-full min-h-20 flex-col justify-between rounded-md border border-border-subtle bg-muted p-2 transition-all hover:border-border-focus"
    >
      <span className="font-medium text-foreground text-xs uppercase tracking-wide">
        <Trans>Object</Trans>
      </span>
      <span className="truncate text-foreground text-sm">{label}</span>
      {object.mimeType ? (
        <span className="text-muted-foreground text-xs">{object.mimeType}</span>
      ) : null}
    </a>
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
      <div className="flex items-center justify-between border-border-subtle border-b px-3 py-1.5">
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
