/** Composer Agent adapter: explicit interactive panel or readonly status topology. */
import { t } from "@lingui/core/macro";
import { useRef } from "react";
import type { CreationAgent } from "@/client/first-send-continuity";
import { useAgentCatalog } from "@/client/query/useAgentCatalog";
import {
  ComposerCurrentValueStatus,
  ComposerCurrentValueTrigger,
  type ComposerToolbarControl,
} from "@/components/app/composer-toolbar";
import { AgentPickerPanel } from "./AgentPicker";

export type ComposerAgentControlProps =
  | {
      mode: "interactive";
      selectedAgent: CreationAgent | null;
      onSelectedAgentChange: (agent: CreationAgent) => void;
    }
  | { mode: "readonly"; name: string };

export function useComposerAgentToolbarControl(
  props: ComposerAgentControlProps,
): ComposerToolbarControl {
  const catalog = useAgentCatalog(props.mode === "interactive");
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const selectedAgent = props.mode === "interactive" ? props.selectedAgent : null;
  const agent = {
    name: props.mode === "readonly" ? props.name : (selectedAgent?.name ?? t`Choose Agent`),
  };
  const item = { ariaLabel: t`Agent: ${agent.name}`, label: t`Agent`, value: agent.name };
  if (props.mode === "readonly")
    return {
      kind: "status",
      id: "agent",
      priority: 300,
      item,
      inline: ({ controlRef }) => (
        <ComposerCurrentValueStatus
          ref={controlRef}
          ariaLabel={t`Agent: ${agent.name}`}
          tooltip={t`This chat uses ${agent.name}.`}
        >
          {agent.name}
        </ComposerCurrentValueStatus>
      ),
    };
  const enabledIds =
    catalog.status === "ready"
      ? (catalog.agents ?? [])
          .filter((agent) => !agent.unavailableReasons.length)
          .map((agent) => agent.selection.catalogEntryId)
      : [];
  const pageId =
    catalog.status === "error"
      ? "error"
      : catalog.status === "ready"
        ? "ready"
        : catalog.status === "empty"
          ? "empty"
          : "loading";
  return {
    kind: "panel",
    id: "agent",
    priority: 300,
    interaction: "enabled",
    item: { ...item, ariaLabel: t`Choose agent, currently ${agent.name}` },
    inline: ({ trigger }) => (
      <ComposerCurrentValueTrigger binding={trigger} ariaLabel={t`Agent: ${agent.name}`}>
        {agent.name}
      </ComposerCurrentValueTrigger>
    ),
    panel: {
      ariaLabel: t`Choose agent`,
      size: "identity",
      focus: {
        pageId,
        repairRevision: enabledIds.join("\0"),
        candidates:
          pageId === "ready"
            ? [
                {
                  key: `selected:${selectedAgent?.selection.catalogEntryId ?? "none"}`,
                  ref: selectedRef,
                },
                { key: `first:${enabledIds[0] ?? "none"}`, ref: firstRef },
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
          selectedAgent={selectedAgent}
          onSelect={(next) => {
            props.onSelectedAgentChange(next);
            terminalClose();
          }}
        />
      ),
    },
  };
}
