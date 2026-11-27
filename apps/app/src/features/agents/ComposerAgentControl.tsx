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
} from "@/features/chat/composer/toolbar";
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
      overrides: ThreadOverrides;
      onChoose: (choice: AgentChoice) => void;
    }
  | {
      mode: "started";
      projectId: string;
      threadId: string;
      bound: BoundAgent;
      overrides: ThreadOverrides;
      onOverridesChange: (overrides: ThreadOverrides) => void;
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
  const options = useModelOptions(props.mode !== "readonly" || model !== null);
  const models = options?.models ?? null;
  const searchRef = useRef<HTMLInputElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const agents = catalog.status === "ready" ? (catalog.agents ?? []) : [];
  const selectable = pickableAgents(agents);
  const selectedAgent =
    props.mode === "interactive"
      ? props.selectedAgent
      : props.mode === "started"
        ? boundAgentRow(selectable, props.bound)
        : null;
  const name =
    props.mode === "readonly"
      ? props.name
      : props.mode === "started"
        ? (props.bound.name ?? DEFAULT_AGENT_NAME)
        : (selectedAgent?.name ?? DEFAULT_AGENT_NAME);
  const modelLabel = model ? modelName(models, model) : null;
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
  const item = {
    ariaLabel: t`Agent: ${value}`,
    label: t`Agent`,
    value: [name, modelLabel, effortLabel].filter(Boolean).join(" "),
  };
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
  const pageId =
    catalog.status === "error"
      ? "error"
      : catalog.status === "ready" && agents.some((agent) => agent.primary)
        ? "ready"
        : catalog.status === "empty" || catalog.status === "ready"
          ? "empty"
          : "loading";
  return {
    kind: "panel",
    id: "agent",
    priority: 300,
    interaction: props.mode === "started" && !props.onHandoff ? "busy" : "enabled",
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
      ariaLabel: props.mode === "started" ? t`This chat's Agent` : t`Choose agent`,
      size: "split",
      focus: {
        pageId,
        repairRevision: selectable.map((agent) => agent.selection.slug).join("\0"),
        candidates:
          pageId === "ready"
            ? [{ key: "search", ref: searchRef }]
            : pageId === "error"
              ? [{ key: "retry", ref: retryRef }]
              : [],
        fallback: "content",
      },
      render: ({ terminalClose }) => (
        <AgentPickerPanel
          focusRefs={{ search: searchRef, retry: retryRef }}
          status={catalog}
          current={{ slug: selectedAgent?.selection.slug ?? null, overrides }}
          mode={
            props.mode === "interactive"
              ? { kind: "new", onChoose: props.onChoose }
              : {
                  kind: "chat",
                  threadId: props.threadId,
                  onChoose: (next) => props.onOverridesChange(next.overrides),
                  onHandoff: (next) => props.onHandoff?.(next),
                }
          }
          options={options}
          projectId={props.projectId ?? ""}
          onClose={terminalClose}
        />
      ),
    },
  };
}
