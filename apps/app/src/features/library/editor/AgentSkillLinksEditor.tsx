/**
 * AgentSkillLinksEditor — per-agent skill wiring rows.
 *
 * Reordering edits versioned `meta.skills` (saved via PUT). `modelInvocable`
 * toggles apply immediately via PATCH — operational state, not draft content.
 */
import { Trans } from "@lingui/react/macro";
import type { AgentSkillLinkDetail } from "@meridian/contracts/agents";
import { ChevronDown, ChevronUp } from "lucide-react";
import { DefinitionSection } from "./DefinitionFormLayout";

export function AgentSkillLinksEditor({
  links,
  disabled,
  onReorder,
  onToggleModelInvocable,
  pendingSkillSlug,
}: {
  links: AgentSkillLinkDetail[];
  disabled?: boolean;
  onReorder: (index: number, direction: -1 | 1) => void;
  onToggleModelInvocable: (skillSlug: string, modelInvocable: boolean) => void;
  pendingSkillSlug?: string | null;
}) {
  if (links.length === 0) {
    return (
      <DefinitionSection title={<Trans>Skills</Trans>}>
        <p className="text-meta text-muted-foreground">
          <Trans>No skills linked to this agent.</Trans>
        </p>
      </DefinitionSection>
    );
  }

  return (
    <DefinitionSection
      title={<Trans>Skills</Trans>}
      description={
        <Trans>Choose which skills new chats can use. Changes apply to new chats only.</Trans>
      }
    >
      <ul className="flex flex-col gap-2">
        {links.map((link, index) => (
          <li
            key={link.skillSlug}
            className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-card px-3 py-2"
          >
            <div className="min-w-0">
              <code className="font-mono text-sm text-foreground">{link.skillSlug}</code>
              <p className="text-meta text-muted-foreground">
                <Trans>Agent can use this skill</Trans>
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <label className="inline-flex items-center gap-2 text-meta text-foreground">
                <input
                  type="checkbox"
                  checked={link.modelInvocable ?? true}
                  disabled={disabled || pendingSkillSlug === link.skillSlug}
                  aria-label={link.skillSlug}
                  onChange={(event) => onToggleModelInvocable(link.skillSlug, event.target.checked)}
                  className="size-4 accent-primary disabled:opacity-60"
                />
              </label>
              <div className="flex flex-col">
                <button
                  type="button"
                  disabled={disabled || index === 0}
                  aria-label={`Move ${link.skillSlug} up`}
                  onClick={() => onReorder(index, -1)}
                  className="focus-ring rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
                >
                  <ChevronUp className="size-3.5" />
                </button>
                <button
                  type="button"
                  disabled={disabled || index === links.length - 1}
                  aria-label={`Move ${link.skillSlug} down`}
                  onClick={() => onReorder(index, 1)}
                  className="focus-ring rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
                >
                  <ChevronDown className="size-3.5" />
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </DefinitionSection>
  );
}
