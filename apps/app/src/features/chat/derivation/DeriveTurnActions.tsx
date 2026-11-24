import { t } from "@lingui/core/macro";
import { NO_OVERRIDES } from "@meridian/contracts/threads";
import { Forward, GitFork } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useAgentCatalog } from "@/client/query/useAgentCatalog";
import { useModelOptions } from "@/client/query/useModelOptions";
import { useDensityPopoverCollisionProps } from "@/components/ui/density-popover-collision";
import { dropdownSurfaceVariants } from "@/components/ui/dropdown-presentation";
import { IconButton } from "@/components/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type AgentChoice, AgentPickerPanel } from "@/features/agents/AgentPicker";
import { type BoundAgent, boundAgentRow, pickableAgents } from "@/features/agents/creation-agent";
import { cn } from "@/lib/utils";
import { TURN_ACTION_TOOLTIP_SIDE } from "../turn-action-tooltip";

export type TurnDerivation = {
  projectId: string;
  sourceAgent: BoundAgent;
  fork: (turnId: string) => void;
  handoff: (turnId: string, choice: AgentChoice) => void;
};

const TurnDerivationContext = createContext<TurnDerivation | null>(null);

export const TurnDerivationProvider = TurnDerivationContext.Provider;

export function useTurnDerivation(): TurnDerivation | null {
  return useContext(TurnDerivationContext);
}

export function canDeriveFrom(input: {
  kind: "primary" | "subagent" | null;
  pendingCreation: boolean;
  canOpen: boolean;
}): boolean {
  return input.kind === "primary" && !input.pendingCreation && input.canOpen;
}

export function DeriveTurnActions({ turnId }: { turnId: string }) {
  const derivation = useTurnDerivation();
  if (!derivation) return null;
  return (
    <>
      <ForkTurnAction turnId={turnId} />
      <HandoffPicker turnId={turnId} derivation={derivation} align="start" />
    </>
  );
}

export function ForkTurnAction({ turnId }: { turnId: string }) {
  const derivation = useTurnDerivation();
  if (!derivation) return null;
  return (
    <IconButton
      type="button"
      label={t`Fork from here`}
      tooltipSide={TURN_ACTION_TOOLTIP_SIDE}
      onClick={() => derivation.fork(turnId)}
    >
      <GitFork aria-hidden />
    </IconButton>
  );
}

export function HandoffTurnAction({ turnId }: { turnId: string }) {
  const derivation = useTurnDerivation();
  if (!derivation) return null;
  return <HandoffPicker turnId={turnId} derivation={derivation} align="end" />;
}

function HandoffPicker({
  turnId,
  derivation,
  align,
}: {
  turnId: string;
  derivation: TurnDerivation;
  align: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const collision = useDensityPopoverCollisionProps();
  const catalog = useAgentCatalog(open, derivation.projectId);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const options = useModelOptions(open);
  const agents = catalog.status === "ready" ? (catalog.agents ?? []) : [];
  const selected = boundAgentRow(pickableAgents(agents), derivation.sourceAgent);
  const label = t`Hand off from here`;
  const ready = catalog.status;
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const content = contentRef.current;
      if (!content || content.ownerDocument.activeElement !== content) return;
      (searchRef.current ?? retryRef.current)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, ready, agents.length]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton type="button" label={label} tooltipSide={TURN_ACTION_TOOLTIP_SIDE}>
          <Forward aria-hidden />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        tabIndex={-1}
        align={align}
        {...collision}
        aria-label={t`Hand off to an Agent`}
        className={cn(dropdownSurfaceVariants({ measure: "split" }), "text-tier-chat")}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
      >
        <AgentPickerPanel
          status={catalog}
          current={{ slug: selected?.selection.slug ?? null, overrides: NO_OVERRIDES }}
          mode={{ kind: "turn", onHandoff: (choice) => derivation.handoff(turnId, choice) }}
          options={options}
          focusRefs={{ search: searchRef, retry: retryRef }}
          projectId={derivation.projectId}
          onClose={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}
