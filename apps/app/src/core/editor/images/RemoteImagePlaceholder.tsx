import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { IMAGE_PROXY_MAX_BYTES, type ImageProxyReason } from "@meridian/contracts/protocol";
import { ImageIcon, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { loadRemoteImage, useRemoteImageStatus } from "./remote-image";

function refusalMessage(reason: ImageProxyReason | null): string {
  switch (reason) {
    case "too_large": {
      const megabytes = IMAGE_PROXY_MAX_BYTES / (1024 * 1024);
      return t`Too large to load (the limit is ${megabytes} MB).`;
    }
    case "not_image":
      return t`That address is not an image.`;
    case "not_allowed":
      return t`That address is not allowed (private or local).`;
    case "port":
      return t`Only addresses on the standard web ports can be loaded.`;
    case "unreachable":
      return t`The server didn't answer.`;
    case "timeout":
      return t`The server took too long to answer.`;
    case null:
      return t`The image could not be loaded.`;
  }
}

/** What a remote picture shows until the writer loads it: its address, and the button that loads it. */
export function RemoteImagePlaceholder({ address, alt }: { address: string; alt: string }) {
  const status = useRemoteImageStatus(address);
  const loading = status?.kind === "loading";
  return (
    <span className="inline-flex max-w-full flex-col items-start gap-2 rounded-md border border-border-subtle border-dashed bg-ink-fill p-3 align-top text-muted-foreground text-sm">
      <span className="flex min-w-0 max-w-full items-start gap-2">
        <ImageIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span className="flex min-w-0 flex-col gap-0.5">
          {alt ? <span className="break-words text-foreground">{alt}</span> : null}
          <span className="break-all text-xs" data-remote-image-address>
            {address}
          </span>
        </span>
      </span>
      {status?.kind === "failed" ? (
        <span className="text-destructive text-xs" role="alert">
          {refusalMessage(status.reason)}
        </span>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={loading}
        onClick={() => void loadRemoteImage(address)}
      >
        {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
        <Trans>Load image</Trans>
      </Button>
    </span>
  );
}
