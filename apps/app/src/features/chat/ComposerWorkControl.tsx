/** Work toolbar adapter over the single typed Work binding controller. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import { useRef } from "react";
import {
  ComposerCurrentValueTrigger,
  type ComposerToolbarControl,
} from "@/components/app/composer-toolbar";
import {
  deriveWorkPickerViewModel,
  WorkPickerPanel,
} from "@/components/app/work-composer-controls";
import { useComposerWorkBinding } from "./useComposerWorkBinding";

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
      <ComposerCurrentValueTrigger
        binding={trigger}
        ariaLabel={t`Change work for this chat, currently ${work.name}`}
      >
        {work.name}
      </ComposerCurrentValueTrigger>
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
