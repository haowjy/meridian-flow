/**
 * The AI write-mode control for composers: a chat's mode in an existing chat,
 * the selected Work's default in a new one.
 *
 * Choosing a mode is the writer's whole action: no dialog. The caller owns what
 * the choice does (queue a switch, or remember it for the first send), so the
 * control shows a value and reports a choice. Branch carries the number of
 * documents waiting in the Work's draft, read from the shared draft-list query
 * in either mode, so the menu's Branch option shows the count from Auto-apply too.
 */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { AiWriteMode } from "@meridian/contracts/works";
import { useRef } from "react";
import { useWorkBranches } from "@/client/query/useWorkBranches";
import {
  ComposerCurrentValueTrigger,
  type ComposerToolbarControl,
} from "@/components/app/composer-toolbar";
import { Button } from "@/components/ui/button";
import { dropdownRowVariants } from "@/components/ui/dropdown-presentation";

export function useWriteModeToolbarControl({
  projectId,
  workId,
  value,
  onChoose,
}: {
  projectId: string;
  workId: string;
  value: AiWriteMode;
  onChoose(mode: AiWriteMode): void;
}): ComposerToolbarControl {
  const waiting = useWorkBranches(projectId, workId).files?.length ?? 0;
  const draftRef = useRef<HTMLButtonElement | null>(null);
  const directRef = useRef<HTMLButtonElement | null>(null);
  const draftLabel = waiting > 0 ? t`Drafts (${waiting})` : t`Draft`;
  const localizedValue = value === "draft" ? draftLabel : t`Auto-apply`;
  const spokenDraft =
    waiting > 0
      ? plural(waiting, { one: "Drafts, # document waiting", other: "Drafts, # documents waiting" })
      : draftLabel;
  const spokenValue = value === "draft" ? spokenDraft : localizedValue;
  return {
    kind: "panel",
    id: "write-mode",
    priority: 200,
    interaction: "enabled",
    item: {
      ariaLabel: t`AI write mode: ${spokenValue}`,
      label: <Trans>Write mode</Trans>,
      value: localizedValue,
    },
    inline: ({ trigger }) => (
      <ComposerCurrentValueTrigger binding={trigger} ariaLabel={t`AI write mode: ${spokenValue}`}>
        {localizedValue}
      </ComposerCurrentValueTrigger>
    ),
    panel: {
      ariaLabel: t`AI write mode`,
      size: "compact",
      focus: {
        pageId: "choices",
        repairRevision: value,
        candidates: [
          { key: `selected:${value}`, ref: value === "draft" ? draftRef : directRef },
          { key: "first:draft", ref: draftRef },
        ],
        fallback: "content",
      },
      render: ({ terminalClose }) => (
        <div
          role="radiogroup"
          aria-label={t`AI write mode`}
          className="space-y-[var(--chat-space-row)]"
        >
          {(["draft", "direct"] as const).map((mode) => (
            <Button
              key={mode}
              ref={mode === "draft" ? draftRef : directRef}
              role="radio"
              aria-checked={value === mode}
              aria-label={mode === "draft" ? spokenDraft : undefined}
              variant="ghost"
              className={dropdownRowVariants({ selected: value === mode })}
              onClick={() => {
                if (mode !== value) onChoose(mode);
                terminalClose();
              }}
            >
              {mode === "draft" ? draftLabel : <Trans>Auto-apply</Trans>}
            </Button>
          ))}
        </div>
      ),
    },
  };
}
