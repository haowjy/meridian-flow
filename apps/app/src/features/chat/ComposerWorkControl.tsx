/** Work toolbar adapter over the single typed Work binding controller. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import { useRef } from "react";
import {
  ComposerCurrentValueTrigger,
  type ComposerToolbarControl,
} from "@/components/app/composer-toolbar";
import { Button } from "@/components/ui/button";
import { useComposerWorkBinding } from "./useComposerWorkBinding";
import { deriveWorkPickerViewModel, WorkPickerPanel } from "./WorkPickerPanel";

export function useComposerWorkToolbarControl({
  projectId,
  threadId,
  work,
}: {
  projectId: string;
  threadId: string;
  work: Work;
}): ComposerToolbarControl {
  const controller = useComposerWorkBinding({ projectId, threadId, work });
  const searchRef = useRef<HTMLInputElement | null>(null);
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const query = controller.state.view.query;
  const view = deriveWorkPickerViewModel(controller.catalog, query, controller.busy);
  const pageId = view.status;
  return {
    kind: "panel",
    id: "work",
    priority: 100,
    interaction: controller.busy ? "busy" : "enabled",
    item: {
      ariaLabel: t`Change work for this chat, currently ${work.name}`,
      label: <Trans>Work</Trans>,
      value: work.name,
    },
    inline: ({ trigger }) => (
      <span className="flex items-center">
        <ComposerCurrentValueTrigger
          binding={trigger}
          ariaLabel={t`Change work for this chat, currently ${work.name}`}
        >
          {work.name}
        </ComposerCurrentValueTrigger>
        {controller.undoWork ? (
          <Button
            variant="link"
            size="meta"
            type="button"
            disabled={controller.busy}
            className="ml-1"
            onClick={controller.undo}
          >
            <Trans>Undo</Trans>
          </Button>
        ) : null}
      </span>
    ),
    panel: {
      ariaLabel: t`Change work for this chat`,
      size: "catalog",
      focus: {
        pageId,
        repairRevision: [query, view.enabled, ...view.enabledIds].join("\0"),
        candidates:
          pageId === "ready"
            ? [
                { key: "search", ref: searchRef },
                ...(!controller.busy
                  ? [
                      { key: `selected:${work.id}`, ref: selectedRef },
                      { key: `first:${view.enabledIds[0] ?? "none"}`, ref: firstRef },
                    ]
                  : []),
              ]
            : pageId === "error"
              ? [{ key: "retry", ref: retryRef }]
              : [],
        fallback: "content",
      },
      render: ({ beginBlocking }) => (
        <WorkPickerPanel
          view={view}
          operation={controller.operation}
          onQueryChange={controller.changeQuery}
          onChoose={(target) => {
            const lock = beginBlocking();
            if (lock.kind === "started") void controller.choose(target).then(lock.settle);
          }}
          searchRef={searchRef}
          focusRefs={{ selected: selectedRef, first: firstRef, retry: retryRef }}
        />
      ),
    },
  };
}
