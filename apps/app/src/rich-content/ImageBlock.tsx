/**
 * ImageBlock — renders an inline/thumbnail image block in the chat surface with
 * loading skeleton and error fallback.
 *
 * Re-exports the pure parsing helpers from `image-block-utils` (kept React-free
 * for testing). Owns only the image block's presentation.
 */
import { t } from "@lingui/core/macro";
import { ImageOff } from "lucide-react";
import { useState } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Pure parsing logic lives in a separate module so it can be imported and
// tested in a node/vitest environment without pulling in React.
export type { ImageBlockContent } from "./image-block-utils";
export { parseImageBlockContent } from "./image-block-utils";

import type { ImageBlockContent } from "./image-block-utils";

export type ImageBlockProps = {
  content: ImageBlockContent;
  /**
   * Visual size. `inline` (default) — full-width within the chat column.
   * `thumb` — small folded preview rendered inside `ProcessDisclosure`.
   */
  variant?: "inline" | "thumb";
  className?: string;
};

type LoadState = "loading" | "loaded" | "error";

/**
 * Render an `image` block's content. Lazy-loaded `<img>` with a subtle border
 * and rounded corners; while loading we show a Skeleton placeholder; if the
 * URL fails we render an `ImageOff` fallback with the alt text so the chat
 * never goes blank.
 */
export function ImageBlock({ content, variant = "inline", className }: ImageBlockProps) {
  const [state, setState] = useState<LoadState>("loading");

  const alt = content.alt?.trim() || t`Demo image`;
  const isThumb = variant === "thumb";

  if (state === "error") {
    return (
      <figure
        className={cn(
          "surface-card flex items-center gap-3 rounded-lg bg-surface-warm px-3 py-3 text-muted-foreground",
          isThumb && "max-w-[220px] gap-2 px-2 py-2 text-[12px]",
          className,
        )}
        aria-label={alt}
      >
        <ImageOff className={cn("shrink-0", isThumb ? "size-4" : "size-5")} aria-hidden />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className={cn("font-medium", isThumb ? "text-[12px]" : "text-[13px]")}>
            {t`Failed to load image`}
          </span>
          <span
            className={cn(
              "truncate text-muted-foreground",
              isThumb ? "text-caption" : "text-[12.5px]",
            )}
          >
            {alt}
          </span>
        </div>
      </figure>
    );
  }

  return (
    <figure
      className={cn(
        "my-4 overflow-hidden rounded-lg border border-border-subtle bg-surface-warm shadow-card",
        isThumb && "my-2 max-w-[220px] rounded-md shadow-none",
        className,
      )}
    >
      <div className={cn("relative w-full", isThumb && "max-w-[220px]")}>
        {state === "loading" ? (
          <Skeleton
            className={cn("aspect-[16/9] w-full rounded-none", isThumb && "aspect-[4/3]")}
            role="status"
            aria-label={t`Loading image`}
          />
        ) : null}
        <img
          src={content.url}
          alt={alt}
          loading="lazy"
          className={cn(
            "block w-full",
            isThumb ? "aspect-[4/3] object-cover" : "max-h-[520px] object-cover",
            state === "loading" && "absolute inset-0 opacity-0",
          )}
          onLoad={() => setState("loaded")}
          onError={() => setState("error")}
        />
      </div>
      {content.caption ? (
        <figcaption
          className={cn(
            "border-t border-border-subtle bg-surface-warm px-3 py-2 text-muted-foreground",
            isThumb ? "text-caption" : "text-[12.5px] leading-snug",
          )}
        >
          {content.caption}
        </figcaption>
      ) : null}
    </figure>
  );
}
