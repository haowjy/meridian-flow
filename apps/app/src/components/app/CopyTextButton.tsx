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
};

export function CopyTextButton({ text, children, ...buttonProps }: CopyTextButtonProps) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current != null) window.clearTimeout(resetTimerRef.current);
    };
  }, []);

  async function handleCopy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    if (resetTimerRef.current != null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
  }

  return (
    <Button type="button" onClick={handleCopy} {...buttonProps}>
      {copied ? <Trans>Copied</Trans> : children}
    </Button>
  );
}
