/**
 * Composer Agent control. A new chat picks its Agent; a started chat is bound to one, so
 * picking another hands off to it; a subagent's chat only shows its Agent.
 */
import { t } from "@lingui/core/macro";
import { useRef } from "react";
import { useAgentCatalog } from "@/client/query/useAgentCatalog";
import {
  ComposerCurrentValueStatus,
  ComposerCurrentValueTrigger,
  type ComposerToolbarControl,
} from "@/components/app/composer-toolbar";
import { dropdownGroupLabelClass } from "@/components/ui/dropdown-presentation";
import { AgentPickerPanel } from "./AgentPicker";
import { DEFAULT_AGENT_NAME } from "./constants";
import { type BoundAgent, boundAgentRow, type CreationAgent } from "./creation-agent";

export type ComposerAgentControlProps =
  | {
      mode: "interactive";
      projectId?: string;
      selectedAgent: CreationAgent | null;
      onSelectedAgentChange: (agent: CreationAgent) => void;
    }
  | {
      mode: "handoff";
      projectId: string;
      bound: BoundAgent;
      /** Null until the server has a turn to hand off from. */
      onHandoff: ((agent: CreationAgent) => void) | null;
    }
  | { mode: "readonly"; name: string };

export function useComposerAgentToolbarControl(
  props: ComposerAgentControlProps,
): ComposerToolbarControl {
  const catalog = useAgentCatalog(
    props.mode !== "readonly",
    props.mode === "readonly" ? undefined : props.projectId,
  );
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const selectable =
    catalog.status === "ready"
      ? (catalog.agents ?? []).filter((agent) => agent.unavailableReasons.length === 0)
      : [];
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
  const item = { ariaLabel: t`Agent: ${name}`, label: t`Agent`, value: name };
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
  const focusableIds = selectable.map((agent) => agent.selection.catalogEntryId);
  const pageId =
    catalog.status === "error"
      ? "error"
      : catalog.status === "ready" && selectable.length > 0
        ? "ready"
        : catalog.status === "empty" || catalog.status === "ready"
          ? "empty"
          : "loading";
  const choose = (next: CreationAgent) => {
    if (props.mode === "interactive") props.onSelectedAgentChange(next);
    else if (next.selection.catalogEntryId !== selectedAgent?.selection.catalogEntryId)
      props.onHandoff?.(next);
  };
  return {
    kind: "panel",
    id: "agent",
    priority: 300,
    interaction: props.mode === "handoff" && !props.onHandoff ? "busy" : "enabled",
    item: { ...item, ariaLabel: t`Choose agent, currently ${name}` },
    inline: ({ trigger }) => (
      <ComposerCurrentValueTrigger binding={trigger} ariaLabel={t`Agent: ${name}`}>
        {name}
      </ComposerCurrentValueTrigger>
    ),
    panel: {
      ariaLabel: props.mode === "handoff" ? t`Hand off to an Agent` : t`Choose agent`,
      size: "identity",
      focus: {
        pageId,
        repairRevision: focusableIds.join("\0"),
        candidates:
          pageId === "ready"
            ? [
                {
                  key: `selected:${selectedAgent?.selection.catalogEntryId ?? "none"}`,
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
        <>
          {props.mode === "handoff" ? (
            <p className={dropdownGroupLabelClass}>{t`Hand off to`}</p>
          ) : null}
          <AgentPickerPanel
            focusRefs={{ selected: selectedRef, first: firstRef, retry: retryRef }}
            status={catalog}
            agents={selectable}
            selectedAgent={selectedAgent}
            onSelect={(next) => {
              choose(next);
              terminalClose();
            }}
          />
        </>
      ),
    },
  };
}
