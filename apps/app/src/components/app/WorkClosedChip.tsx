import { Trans } from "@lingui/react/macro";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Chip } from "@/components/ui/chip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const LONG_PRESS_MS = 450;
const SHOWN_MS = 4000;

export function WorkClosedChip({
  sentence,
  id,
  label,
}: {
  sentence: string;
  id?: string;
  label?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const press = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setOpen(true);
      timer.current = setTimeout(() => setOpen(false), SHOWN_MS);
    }, LONG_PRESS_MS);
  };
  const release = () => {
    if (!open) clearTimeout(timer.current);
  };
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <Chip
          id={id}
          tone="warning"
          tabIndex={0}
          aria-label={sentence}
          className="ml-1.5 min-w-0 max-w-40 shrink select-none truncate"
          onPointerDown={(event) => event.pointerType === "touch" && press()}
          onPointerUp={release}
          onPointerCancel={release}
          onContextMenu={(event) => event.preventDefault()}
        >
          {label ?? <Trans>Work was closed</Trans>}
        </Chip>
      </TooltipTrigger>
      <TooltipContent side="right">{sentence}</TooltipContent>
    </Tooltip>
  );
}
