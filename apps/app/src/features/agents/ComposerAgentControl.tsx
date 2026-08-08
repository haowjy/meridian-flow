/** Composer Agent adapter: one catalog/open-state owner for inline and overflow hosts. */
import { t } from "@lingui/core/macro";
import { useState } from "react";
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
  const [open, setOpen] = useState(false);
  const slug = props.selectedSlug || DEFAULT_AGENT_SLUG;
  const agent = resolveAgentFromCatalog(slug, catalog.agents);
  const inline = ({ requestOpen }: { requestOpen(): void }) => (
    <AgentSelector
      agent={agent}
      disabled={props.mode === "readonly"}
      onClick={requestOpen}
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
  const choose = (next: string) => {
    props.onSelectedSlugChange(next);
    setOpen(false);
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
        open,
        busy: false,
        canDismiss: true,
        ariaLabel: t`Choose agent`,
        size: "picker",
        onRequestOpen: () => setOpen(true),
        onRequestDismiss: () => setOpen(false),
        render: () => <AgentPickerPanel status={catalog} selectedSlug={slug} onSelect={choose} />,
      },
    },
  };
}
