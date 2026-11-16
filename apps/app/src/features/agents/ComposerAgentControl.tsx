/**
 * Composer Agent control. A new chat picks its Agent and the model it runs on; a started chat is
 * bound to one, so it can change only the model, and picking another Agent hands off to it; a
 * subagent's chat only shows its Agent.
 */
import { t } from "@lingui/core/macro";
import type { ThreadOverrides } from "@meridian/contracts/threads";
import { Cpu } from "lucide-react";
import { useRef } from "react";
import { useAgentCatalog } from "@/client/query/useAgentCatalog";
import { useModelOptions } from "@/client/query/useModelOptions";
import {
  ComposerCurrentValueStatus,
  ComposerCurrentValueTrigger,
  type ComposerToolbarControl,
} from "@/components/app/composer-toolbar";
import { cn } from "@/lib/utils";
import {
  type AgentChoice,
  AgentPickerPanel,
  modelName,
  reasoningName,
  runsAvailable,
} from "./AgentPicker";
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
      /** The model and reasoning the new chat will run its Agent at, where not its own. */
      overrides: ThreadOverrides;
      onChoose: (choice: AgentChoice) => void;
    }
  | {
      mode: "handoff";
      projectId: string;
      /** The chat, whose bound definition the panel can open. */
      threadId: string;
      bound: BoundAgent;
      overrides: ThreadOverrides;
      onOverridesChange: (overrides: ThreadOverrides) => void;
      /** Null until the server has a turn to hand off from. */
      onHandoff: ((choice: AgentChoice) => void) | null;
    }
  | { mode: "readonly"; name: string; overrides: ThreadOverrides };

export function useComposerAgentToolbarControl(
  props: ComposerAgentControlProps,
): ComposerToolbarControl {
  const catalog = useAgentCatalog(
    props.mode !== "readonly",
    props.mode === "readonly" ? undefined : props.projectId,
  );
  const overrides = props.overrides;
  const model = overrides.model;
  const models = useModelOptions(props.mode !== "readonly" || model !== null);
  const searchRef = useRef<HTMLInputElement | null>(null);
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
  const modelLabel = model ? modelName(models, model) : null;
  // An override the deployment can't run: replies fall back to the Agent's own model.
  const fallsBack = Boolean(model && models && !runsAvailable(models, model));
  const effortLabel = overrides.effort ? reasoningName(overrides.effort) : null;
  const runsAt = [modelLabel, effortLabel && t`${effortLabel} reasoning`]
    .filter(Boolean)
    .join(", ");
  const value = !runsAt
    ? name
    : fallsBack
      ? t`${name}; ${modelLabel ?? ""} isn't available, so it runs on its default model`
      : t`${name} on ${runsAt}`;
  // The overflow row shows what the chip shows; the sentence is for its name and tooltip.
  const item = {
    ariaLabel: t`Agent: ${value}`,
    label: t`Agent`,
    value: [name, modelLabel, effortLabel].filter(Boolean).join(" "),
  };
  // The other model's and reasoning's names; on a phone a chip icon, so the Agent's name keeps its
  // place inline.
  const shown = (
    <>
      {name}
      {modelLabel || effortLabel ? (
        <>
          {modelLabel ? (
            <span
              className={cn(
                "ml-1.5 hidden font-normal text-muted-foreground sm:inline",
                fallsBack && "line-through",
              )}
            >
              {modelLabel}
            </span>
          ) : null}
          {effortLabel ? (
            <span className="ml-1.5 hidden font-normal text-muted-foreground sm:inline">
              {effortLabel}
            </span>
          ) : null}
          <Cpu
            aria-hidden
            className="ml-1 inline size-3.5 align-[-2px] text-muted-foreground sm:hidden"
          />
        </>
      ) : null}
    </>
  );
  if (props.mode === "readonly")
    return {
      kind: "status",
      id: "agent",
      priority: 300,
      item,
      inline: ({ controlRef }) => (
        <ComposerCurrentValueStatus
          ref={controlRef}
          ariaLabel={t`Agent: ${value}`}
          tooltip={runsAt ? t`This chat uses ${name} on ${runsAt}.` : t`This chat uses ${name}.`}
        >
          {shown}
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
  /** True when the choice hands off, which leaves this chat; any other choice keeps the picker open. */
  const choose = (next: AgentChoice): boolean => {
    const same = next.agent.selection.slug === selectedAgent?.selection.slug;
    if (same && next.overrides.model === model && next.overrides.effort === overrides.effort)
      return false;
    if (props.mode === "interactive") props.onChoose(next);
    else if (same) props.onOverridesChange(next.overrides);
    else {
      props.onHandoff?.(next);
      return true;
    }
    return false;
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
        {shown}
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
                { key: "search", ref: searchRef },
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
          focusRefs={{
            search: searchRef,
            selected: selectedRef,
            first: firstRef,
            retry: retryRef,
          }}
          status={catalog}
          agents={agents}
          current={{ slug: selectedAgent?.selection.slug ?? null, overrides }}
          started={props.mode === "handoff" ? { threadId: props.threadId } : undefined}
          models={models}
          onChoose={(next) => {
            if (choose(next)) terminalClose();
          }}
          projectId={props.projectId ?? ""}
          onClose={terminalClose}
        />
      ),
    },
  };
}
