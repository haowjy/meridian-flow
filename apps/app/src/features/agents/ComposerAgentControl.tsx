/** Composer Agent adapter: explicit interactive panel or readonly status topology. */
import { t } from "@lingui/core/macro";
import { useRef } from "react";
import { useProjectAgents } from "@/client/query/useProjectAgents";
import type { ComposerToolbarControl } from "@/components/app/composer-toolbar";
import { AgentPickerPanel } from "./AgentPicker";
import { AgentPanelTrigger, AgentReadonlyStatus } from "./AgentSelector";
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
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const slug = props.selectedSlug || DEFAULT_AGENT_SLUG;
  const agent = resolveAgentFromCatalog(slug, catalog.agents);
  const item = { ariaLabel: t`Agent: ${agent.name}`, label: t`Agent`, value: agent.name };
  if (props.mode === "readonly")
    return {
      kind: "status",
      id: "agent",
      priority: 300,
      item,
      inline: ({ controlRef }) => (
        <AgentReadonlyStatus
          ref={controlRef}
          agent={agent}
          tooltip={t`This chat stays on ${agent.name} to keep costs predictable. Swapping agents mid-chat is coming.`}
        />
      ),
    };
  const enabledSlugs =
    catalog.status === "ready" ? (catalog.agents ?? []).map(({ slug }) => slug) : [];
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
    inline: ({ trigger }) => <AgentPanelTrigger agent={agent} binding={trigger} />,
    panel: {
      ariaLabel: t`Choose agent`,
      size: "identity",
      focus: {
        pageId,
        repairRevision: enabledSlugs.join("\0"),
        candidates:
          pageId === "ready"
            ? [
                { key: `selected:${slug}`, ref: selectedRef },
                { key: `first:${enabledSlugs[0] ?? "none"}`, ref: firstRef },
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
          selectedSlug={slug}
          onSelect={(next) => {
            props.onSelectedSlugChange(next);
            terminalClose();
          }}
        />
      ),
    },
  };
}
