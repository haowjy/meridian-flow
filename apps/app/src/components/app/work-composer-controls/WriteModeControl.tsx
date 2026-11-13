/**
 * The AI write-mode control for composers: a chat's mode in an existing chat,
 * the selected Work's default in a new one.
 *
 * Choosing a mode is the writer's whole action: no dialog. The caller owns what
 * the choice does (queue a switch, or remember it for the first send), so the
 * control shows a value and reports a choice. The chip says the mode and nothing
 * else; the strip above the composer counts what waits in drafts.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { AiWriteMode } from "@meridian/contracts/works";
import { useRef } from "react";
import {
  ComposerCurrentValueTrigger,
  type ComposerToolbarControl,
} from "@/components/app/composer-toolbar";
import { Button } from "@/components/ui/button";
import { dropdownRowVariants } from "@/components/ui/dropdown-presentation";
import { handleListKeys } from "@/components/ui/list-keys";

export function useWriteModeToolbarControl({
  value,
  onChoose,
}: {
  value: AiWriteMode;
  onChoose(mode: AiWriteMode): void;
}): ComposerToolbarControl {
  const draftRef = useRef<HTMLButtonElement | null>(null);
  const directRef = useRef<HTMLButtonElement | null>(null);
  const localizedValue = value === "draft" ? t`Draft` : t`Auto-apply`;
  return {
    kind: "panel",
    id: "write-mode",
    // How the AI will write is what the writer must see before sending, so it folds last.
    priority: 400,
    interaction: "enabled",
    item: {
      ariaLabel: t`AI write mode: ${localizedValue}`,
      label: <Trans>Write mode</Trans>,
      value: localizedValue,
    },
    inline: ({ trigger }) => (
      <ComposerCurrentValueTrigger
        binding={trigger}
        ariaLabel={t`AI write mode: ${localizedValue}`}
      >
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
          className="space-y-[var(--chat-space-inline)]"
          onKeyDown={handleListKeys}
        >
          {(["draft", "direct"] as const).map((mode) => (
            <Button
              key={mode}
              data-list-item
              ref={mode === "draft" ? draftRef : directRef}
              role="radio"
              aria-checked={value === mode}
              variant="ghost"
              className={dropdownRowVariants({ selected: value === mode })}
              onClick={() => {
                if (mode !== value) onChoose(mode);
                terminalClose();
              }}
            >
              {mode === "draft" ? <Trans>Draft</Trans> : <Trans>Auto-apply</Trans>}
            </Button>
          ))}
        </div>
      ),
    },
  };
}
