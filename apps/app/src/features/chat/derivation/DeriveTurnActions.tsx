/**
 * Fork and Hand off in a finished reply's action row, Hand off alone under a
 * delivered writer message, and Fork alone on a finished compaction divider.
 * The turn is the cutoff.
 *
 * A primary chat provides `TurnDerivation`; a subagent's view does not, so
 * neither action renders there (the server refuses both from a subagent).
 * Fork keeps the Agent and needs no choice. Hand off opens the Agent picker
 * with the source's Agent selected, so Enter hands off to the same Agent.
 * Both navigate at once; creation finishes in the background. Handing off
 * from a writer message includes it: while its reply is still streaming, the
 * brief reports it as the open request.
 */
import { t } from "@lingui/core/macro";
import { NO_OVERRIDES } from "@meridian/contracts/threads";
import { Forward, GitFork } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useAgentCatalog } from "@/client/query/useAgentCatalog";
import { useModelOptions } from "@/client/query/useModelOptions";
import { dropdownSurfaceVariants } from "@/components/ui/dropdown-presentation";
import { IconButton } from "@/components/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type AgentChoice, AgentPickerPanel } from "@/features/agents/AgentPicker";
import { type BoundAgent, boundAgentRow, pickableAgents } from "@/features/agents/creation-agent";
import { cn } from "@/lib/utils";
import { TURN_ACTION_TOOLTIP_SIDE } from "../turn-action-tooltip";

export type TurnDerivation = {
  projectId: string;
  /** The Agent the source chat is bound to, for the picker's default. */
  sourceAgent: BoundAgent;
  fork: (turnId: string) => void;
  handoff: (turnId: string, choice: AgentChoice) => void;
};

const TurnDerivationContext = createContext<TurnDerivation | null>(null);

export const TurnDerivationProvider = TurnDerivationContext.Provider;

export function useTurnDerivation(): TurnDerivation | null {
  return useContext(TurnDerivationContext);
}

/**
 * Whether a chat offers Fork and Hand off: only a primary the server already
 * has (a subagent's view never does; the server refuses both there), and only
 * where a new chat can be opened.
 */
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

/** Fork alone: a compaction divider's action. A fork cut there starts compacted. */
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

/** Hand off alone: a writer message's action. Fork stays on replies. */
export function HandoffTurnAction({ turnId }: { turnId: string }) {
  const derivation = useTurnDerivation();
  if (!derivation) return null;
  // The message sits at the right edge, so the picker opens toward the chat.
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
  const catalog = useAgentCatalog(open, derivation.projectId);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const models = useModelOptions(open);
  const agents = catalog.status === "ready" ? (catalog.agents ?? []) : [];
  const selected = boundAgentRow(pickableAgents(agents), derivation.sourceAgent);
  const label = t`Hand off from here`;
  const ready = catalog.status;
  // Land in the search, as every searchable picker does. The catalog may load after the
  // picker opens; focus waits on the panel until the search exists.
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
          models={models}
          focusRefs={{ search: searchRef, retry: retryRef }}
          projectId={derivation.projectId}
          onClose={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}
