/**
 * Composer Agent control. A new chat picks its Agent and the model it runs on; a started chat is
 * bound to one, so it can change only the model, and picking another Agent hands off to it; a
 * subagent's chat only shows its Agent.
 */
import { t } from "@lingui/core/macro";
import { useRef } from "react";
import { useAgentCatalog } from "@/client/query/useAgentCatalog";
import { useModelOptions } from "@/client/query/useModelOptions";
import {
  ComposerCurrentValueStatus,
  ComposerCurrentValueTrigger,
  type ComposerToolbarControl,
} from "@/components/app/composer-toolbar";
import { cn } from "@/lib/utils";
import { type AgentChoice, AgentPickerPanel, modelName } from "./AgentPicker";
import { DEFAULT_AGENT_NAME } from "./constants";
import {
  type BoundAgent,
  boundAgentRow,
  type CreationAgent,
  pickableAgents,
} from "./creation-agent";

export type ComposerAgentControlProps =
  | {
      mode: "interactive";
      projectId?: string;
      selectedAgent: CreationAgent | null;
      /** The model the new chat will run its Agent on, when not its own. */
      model: string | null;
      onChoose: (choice: AgentChoice) => void;
    }
  | {
      mode: "handoff";
      projectId: string;
      /** The chat, whose bound definition the panel can open. */
      threadId: string;
      bound: BoundAgent;
      modelOverride: string | null;
      onModelChange: (model: string | null) => void;
      /** Null until the server has a turn to hand off from. */
      onHandoff: ((choice: AgentChoice) => void) | null;
    }
  | { mode: "readonly"; name: string };

export function useComposerAgentToolbarControl(
  props: ComposerAgentControlProps,
): ComposerToolbarControl {
  const catalog = useAgentCatalog(
    props.mode !== "readonly",
    props.mode === "readonly" ? undefined : props.projectId,
  );
  const models = useModelOptions(props.mode !== "readonly");
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const agents = catalog.status === "ready" ? (catalog.agents ?? []) : [];
  const selectable = pickableAgents(agents);
  const selectedAgent =
    props.mode === "interactive"
      ? props.selectedAgent
      : props.mode === "handoff"
        ? boundAgentRow(selectable, props.bound)
        : null;
  const name =
    props.mode === "readonly"
      ? props.name
      : props.mode === "handoff"
        ? (props.bound.name ?? DEFAULT_AGENT_NAME)
        : (selectedAgent?.name ?? DEFAULT_AGENT_NAME);
  const model =
    props.mode === "interactive"
      ? props.model
      : props.mode === "handoff"
        ? props.modelOverride
        : null;
  const modelLabel = model ? modelName(models, model) : null;
  // An override the deployment can't run: replies fall back to the Agent's own model.
  const fallsBack = Boolean(
    model && models?.some((option) => option.id === model && !option.available),
  );
  const value = !modelLabel
    ? name
    : fallsBack
      ? t`${name}; ${modelLabel} isn't available, so it runs on its own model`
      : t`${name} on ${modelLabel}`;
  const item = { ariaLabel: t`Agent: ${value}`, label: t`Agent`, value };
  if (props.mode === "readonly")
    return {
      kind: "status",
      id: "agent",
      priority: 300,
      item,
      inline: ({ controlRef }) => (
        <ComposerCurrentValueStatus
          ref={controlRef}
          ariaLabel={t`Agent: ${name}`}
          tooltip={t`This chat uses ${name}.`}
        >
          {name}
        </ComposerCurrentValueStatus>
      ),
    };
  const focusableIds = selectable.map((agent) => agent.selection.slug);
  const pageId =
    catalog.status === "error"
      ? "error"
      : catalog.status === "ready" && agents.some((agent) => agent.primary)
        ? "ready"
        : catalog.status === "empty" || catalog.status === "ready"
          ? "empty"
          : "loading";
  const choose = (next: AgentChoice) => {
    const same = next.agent.selection.slug === selectedAgent?.selection.slug;
    if (same && next.model === model) return;
    if (props.mode === "interactive") props.onChoose(next);
    else if (same) props.onModelChange(next.model);
    else props.onHandoff?.(next);
  };
  return {
    kind: "panel",
    id: "agent",
    priority: 300,
    interaction: props.mode === "handoff" && !props.onHandoff ? "busy" : "enabled",
    item: { ...item, ariaLabel: t`Choose agent, currently ${value}` },
    inline: ({ trigger }) => (
      <ComposerCurrentValueTrigger
        binding={trigger}
        ariaLabel={t`Agent: ${value}`}
        className="max-w-[16rem]"
      >
        {name}
        {modelLabel ? (
          <span
            className={cn(
              "ml-1.5 font-normal",
              fallsBack ? "text-muted-foreground line-through" : "text-jade-text",
            )}
          >
            {modelLabel}
          </span>
        ) : null}
      </ComposerCurrentValueTrigger>
    ),
    panel: {
      ariaLabel: props.mode === "handoff" ? t`This chat's Agent` : t`Choose agent`,
      size: "split",
      focus: {
        pageId,
        repairRevision: focusableIds.join("\0"),
        candidates:
          pageId === "ready"
            ? [
                {
                  key: `selected:${selectedAgent?.selection.slug ?? "none"}`,
                  ref: selectedRef,
                },
                { key: `first:${focusableIds[0] ?? "none"}`, ref: firstRef },
              ]
            : pageId === "error"
              ? [{ key: "retry", ref: retryRef }]
              : [],
        fallback: "content",
      },
      render: ({ terminalClose }) => (
        <AgentPickerPanel
          focusRefs={{ selected: selectedRef, first: firstRef, retry: retryRef }}
          status={catalog}
          agents={agents}
          current={{ slug: selectedAgent?.selection.slug ?? null, model }}
          started={props.mode === "handoff" ? { threadId: props.threadId } : undefined}
          models={models}
          onChoose={(next) => {
            choose(next);
            terminalClose();
          }}
          projectId={props.projectId ?? ""}
          onClose={terminalClose}
        />
      ),
    },
  };
}
