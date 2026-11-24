import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ArtifactRef } from "@meridian/contracts/artifacts";
import { FileText } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { role } from "@/components/ui/roles";
import { DocumentName } from "./DocumentName";

export function ArtifactGrid({ artifacts }: { artifacts: ArtifactRef[] }) {
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
          className="focus-ring group block w-full overflow-hidden rounded-md border border-border-subtle bg-ink-fill"
        >
          <img
            src={image.url}
            alt={label}
            className="aspect-square w-full object-cover transition-transform group-hover:scale-105 group-focus-visible:scale-none"
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
  return (
    <div className="overflow-hidden rounded-md border border-border-subtle bg-ink-fill">
      <div className="flex items-center justify-between border-border-subtle border-b px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)]">
        <span className={role.groupLabel}>
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
