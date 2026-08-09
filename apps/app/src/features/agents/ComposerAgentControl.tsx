/** Composer Agent adapter: one catalog/open-state owner for inline and overflow hosts. */
import { t } from "@lingui/core/macro";
import { useRef } from "react";
import { useProjectAgents } from "@/client/query/useProjectAgents";
import type { ComposerToolbarControl } from "@/components/app/composer-toolbar";
import { AgentPickerPanel } from "./AgentPicker";
import { AgentSelector } from "./AgentSelector";
import { DEFAULT_AGENT_SLUG } from "./constants";
import { resolveAgentFromCatalog } from "./resolve-agent";

export type ComposerAgentControlProps = { projectId: string | null; selectedSlug: string } & (
  | { mode: "interactive"; onSelectedSlugChange: (slug: string) => void }
  | { mode: "readonly"; onSelectedSlugChange?: never }
);

export function useComposerAgentToolbarControl(
  props: ComposerAgentControlProps,
): ComposerToolbarControl {
  const catalog = useProjectAgents(props.projectId);
  const initialFocusRef = useRef<HTMLElement | null>(null);
  const slug = props.selectedSlug || DEFAULT_AGENT_SLUG;
  const agent = resolveAgentFromCatalog(slug, catalog.agents);
  const inline = ({
    activate,
    triggerRef,
  }: {
    activate(): void;
    triggerRef(node: HTMLElement | null): void;
  }) => (
    <AgentSelector
      ref={triggerRef}
      agent={agent}
      disabled={props.mode === "readonly"}
      onClick={activate}
      tooltip={
        props.mode === "readonly"
          ? t`This chat stays on ${agent.name} to keep costs predictable. Swapping agents mid-chat is coming.`
          : undefined
      }
    />
  );
  if (props.mode === "readonly")
    return {
      id: "agent",
      priority: 300,
      inline,
      overflow: {
        kind: "status",
        item: { ariaLabel: t`Agent: ${agent.name}`, label: t`Agent`, value: agent.name },
      },
    };
  return {
    id: "agent",
    priority: 300,
    inline,
    overflow: {
      kind: "panel",
      item: {
        ariaLabel: t`Choose agent, currently ${agent.name}`,
        label: t`Agent`,
        value: agent.name,
      },
      panel: {
        ariaLabel: t`Choose agent`,
        size: "identity",
        initialFocusRef,
        render: ({ terminalClose }) => (
          <AgentPickerPanel
            initialFocusRef={initialFocusRef}
            status={catalog}
            selectedSlug={slug}
            onSelect={(next) => {
              props.onSelectedSlugChange(next);
              terminalClose();
            }}
          />
        ),
      },
    },
  };
}
