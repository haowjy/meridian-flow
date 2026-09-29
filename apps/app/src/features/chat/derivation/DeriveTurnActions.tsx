/**
 * Fork and Hand off in a finished reply's action row, and Hand off alone
 * under a delivered writer message. The turn is the cutoff.
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
import type { AgentCatalogItem } from "@meridian/contracts/agents";
import { Forward, GitFork } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useAgentCatalog } from "@/client/query/useAgentCatalog";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentPickerPanel } from "@/features/agents/AgentPicker";
import type { CreationAgent } from "@/features/agents/creation-agent";

export type TurnDerivation = {
  projectId: string;
  /** The Agent the source chat is bound to, for the picker's default. */
  sourceAgent: { name: string | null; definitionRevisionId: string | null };
  fork: (turnId: string) => void;
  handoff: (turnId: string, agent: CreationAgent) => void;
};

const TurnDerivationContext = createContext<TurnDerivation | null>(null);

export const TurnDerivationProvider = TurnDerivationContext.Provider;

export function useTurnDerivation(): TurnDerivation | null {
  return useContext(TurnDerivationContext);
}

const actionClass = "size-6 text-muted-foreground";

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

/** The picker's default: the source's own revision, else its Agent by name. */
export function defaultHandoffAgent(
  agents: readonly AgentCatalogItem[],
  source: TurnDerivation["sourceAgent"],
): AgentCatalogItem | null {
  return (
    agents.find(
      (agent) =>
        source.definitionRevisionId !== null &&
        agent.selection.definitionRevisionId === source.definitionRevisionId,
    ) ??
    agents.find((agent) => source.name !== null && agent.name === source.name) ??
    null
  );
}

export function DeriveTurnActions({ turnId }: { turnId: string }) {
  const derivation = useTurnDerivation();
  if (!derivation) return null;
  const forkLabel = t`Fork from here`;
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="quiet"
            size="icon-xs"
            className={actionClass}
            aria-label={forkLabel}
            onClick={() => derivation.fork(turnId)}
          >
            <GitFork aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{forkLabel}</TooltipContent>
      </Tooltip>
      <HandoffPicker turnId={turnId} derivation={derivation} align="start" />
    </>
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
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const agents =
    catalog.status === "ready"
      ? (catalog.agents ?? []).filter((agent) => agent.unavailableReasons.length === 0)
      : [];
  const fallback = defaultHandoffAgent(agents, derivation.sourceAgent);
  const selected: CreationAgent | null = fallback
    ? { selection: fallback.selection, slug: fallback.slug, name: fallback.name }
    : null;
  const label = t`Hand off from here`;
  const ready = catalog.status;
  // Land on the source's Agent so Enter hands off to it. The catalog may load
  // after the picker opens; focus waits on the panel until a row exists.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const content = contentRef.current;
      if (!content || content.ownerDocument.activeElement !== content) return;
      (selectedRef.current ?? firstRef.current ?? retryRef.current)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, ready, agents.length]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="quiet"
              size="icon-xs"
              className={actionClass}
              aria-label={label}
            >
              <Forward aria-hidden />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        ref={contentRef}
        tabIndex={-1}
        align={align}
        aria-label={t`Hand off to an Agent`}
        className="text-tier-chat w-72 p-1"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
        // A focused row shows its tooltip, the top dismissable layer, which
        // would swallow the first Escape. One Escape closes the picker.
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          setOpen(false);
        }}
      >
        <p className="px-2 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">
          {t`Hand off to`}
        </p>
        <AgentPickerPanel
          status={catalog}
          agents={agents}
          selectedAgent={selected}
          focusRefs={{ selected: selectedRef, first: firstRef, retry: retryRef }}
          onSelect={(agent) => {
            setOpen(false);
            derivation.handoff(turnId, agent);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
