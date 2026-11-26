import { type ReactNode, useId, useState } from "react";
import { FoldToggle } from "@/components/ui/fold-toggle";
import { cn } from "@/lib/utils";

type ProcessDisclosureProps = {
  label: ReactNode;
  toolCallIds?: readonly string[];
  children: ReactNode;
};

export function ProcessDisclosure({ label, toolCallIds, children }: ProcessDisclosureProps) {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const panelId = useId();

  const handleToggle = () => {
    setOpen((value) => {
      if (!value) setHasOpened(true);
      return !value;
    });
  };

  return (
    <div>
      <FoldToggle
        open={open}
        onToggle={handleToggle}
        aria-controls={panelId}
        data-tool-call-ids={toolCallIds?.length ? toolCallIds.join(" ") : undefined}
        className="w-full text-sm font-medium"
      >
        <span className="min-w-0 truncate">{label}</span>
      </FoldToggle>

      <div
        id={panelId}
        data-process-fold
        aria-hidden={!open}
        className={cn(
          "grid transition-[grid-template-rows] duration-(--motion-duration-panel) ease-out",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-w-0 overflow-hidden">
          <div className="mt-[var(--chat-space-block)]">{hasOpened ? children : null}</div>
        </div>
      </div>
    </div>
  );
}
