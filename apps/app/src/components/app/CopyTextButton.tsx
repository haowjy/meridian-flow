import { Trans } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

const COPIED_RESET_MS = 1500;

type CopyTextButtonProps = React.ComponentProps<typeof Button> & {
  text: string;
  html?: string | (() => string);
  copiedContent?: React.ReactNode;
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
