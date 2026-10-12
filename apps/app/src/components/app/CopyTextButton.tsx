/**
 * CopyTextButton — clipboard copy affordance with a transient "Copied"
 * confirmation. Owns only the copy behavior (clipboard write + reset timer)
 * so review surfaces share one implementation; callers own the visual skin
 * via the usual Button props and supply the at-rest label as children.
 */
import { Trans } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

const COPIED_RESET_MS = 1500;

type CopyTextButtonProps = React.ComponentProps<typeof Button> & {
  /** Text placed on the clipboard when clicked. */
  text: string;
  /** Optional rich representation; plain text remains the markdown source. */
  html?: string | (() => string);
  /** Alternate visual for icon-only controls after a successful copy. */
  copiedContent?: React.ReactNode;
  /** Accessible label while the copied confirmation is visible. */
  copiedLabel?: string;
  onCopiedChange?: (copied: boolean) => void;
};

export function CopyTextButton({
  text,
  html,
  children,
  copiedContent,
  copiedLabel,
  onCopiedChange,
  onClick,
  ...buttonProps
}: CopyTextButtonProps) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current != null) window.clearTimeout(resetTimerRef.current);
    };
  }, []);

  async function handleCopy() {
    try {
      if (html && typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
        const richHtml = typeof html === "function" ? html() : html;
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([richHtml], { type: "text/html" }),
            "text/plain": new Blob([text], { type: "text/plain" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(text);
      }
    } catch {
      return;
    }
    setCopied(true);
    onCopiedChange?.(true);
    if (resetTimerRef.current != null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      onCopiedChange?.(false);
    }, COPIED_RESET_MS);
  }

  return (
    <Button
      type="button"
      {...buttonProps}
      aria-label={copied && copiedLabel ? copiedLabel : buttonProps["aria-label"]}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) void handleCopy();
      }}
    >
      {copied ? (copiedContent ?? <Trans>Copied</Trans>) : children}
    </Button>
  );
}
