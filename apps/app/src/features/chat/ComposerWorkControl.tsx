/** Work toolbar adapter over the single typed Work binding controller. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import type { ComposerToolbarControl } from "@/components/app/composer-toolbar";
import { Button } from "@/components/ui/button";
import { useComposerWorkBinding } from "./useComposerWorkBinding";
import { WorkPickerPanel } from "./WorkPickerPanel";

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
  const query = controller.state.view.kind === "closed" ? "" : controller.state.view.query;
  const panel = (
    <WorkPickerPanel
      catalog={controller.catalog}
      operation={controller.operation}
      query={query}
      onQueryChange={controller.changeQuery}
      onChoose={controller.choose}
    />
  );
  return {
    id: "work",
    priority: 100,
    inline: ({ requestOpen }) => (
      <span className="flex items-center">
        <Button
          variant="quiet"
          size="meta"
          type="button"
          aria-label={t`Change work for this chat, currently ${work.name}`}
          aria-busy={controller.busy}
          className="max-w-44 truncate"
          onClick={requestOpen}
        >
          <Trans>Work: {work.name}</Trans>
        </Button>
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
    overflow: {
      kind: "panel",
      item: {
        ariaLabel: t`Change work for this chat, currently ${work.name}`,
        label: <Trans>Work</Trans>,
        value: work.name,
      },
      panel: {
        open: controller.state.view.kind !== "closed",
        busy: controller.busy,
        canDismiss: controller.canDismiss,
        ariaLabel: t`Change work for this chat`,
        size: "picker",
        onRequestOpen: controller.open,
        onRequestDismiss: controller.requestDismiss,
        render: () => panel,
      },
    },
  };
}
