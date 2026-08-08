/** Thin direct and overflow shells for the composer Work binding controller. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import type { ReactNode } from "react";
import { ComposerToolbar, type ComposerToolbarControl } from "@/components/app/composer-toolbar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useComposerWorkBinding } from "./useComposerWorkBinding";
import { WorkPickerPanel } from "./WorkPickerPanel";

export function ComposerWorkControl({
  projectId,
  threadId,
  work,
  primaryControls,
}: {
  projectId: string;
  threadId: string;
  work: Work;
  primaryControls: ComposerToolbarControl[];
}) {
  const controller = useComposerWorkBinding({ projectId, threadId, work });
  const view = controller.state.view;
  const surface = view.kind === "closed" ? null : view.surface;
  const query = view.kind === "closed" ? "" : view.query;
  const picker = (
    <WorkPickerPanel
      catalog={controller.catalog}
      operation={controller.operation}
      query={query}
      onQueryChange={controller.changeQuery}
      onChoose={controller.choose}
    />
  );
  const direct = (
    <span className="flex items-center">
      <Popover
        open={surface === "direct"}
        onOpenChange={(open) => (open ? controller.open("direct") : controller.requestDismiss())}
      >
        <PopoverTrigger asChild>
          <Button
            variant="quiet"
            size="meta"
            type="button"
            aria-label={t`Change work for this chat, currently ${work.name}`}
            aria-busy={controller.busy}
            className="max-w-44 truncate"
          >
            <Trans>Work: {work.name}</Trans>
          </Button>
        </PopoverTrigger>
        <WorkBindingPopoverContent controller={controller} label={t`Change work for this chat`}>
          <h2 className="font-semibold">
            <Trans>Change work for this chat</Trans>
          </h2>
          <p className="mb-2 text-xs text-muted-foreground">
            <Trans>Currently {work.name}</Trans>
          </p>
          {picker}
        </WorkBindingPopoverContent>
      </Popover>
      {controller.undoWork ? (
        <Button
          variant="link"
          size="meta"
          type="button"
          disabled={controller.busy}
          className="ml-1"
          onClick={() => controller.undo("direct")}
        >
          <Trans>Undo</Trans>
        </Button>
      ) : null}
    </span>
  );
  return (
    <ComposerToolbar
      ariaLabel={t`Composer controls`}
      controls={[
        ...primaryControls,
        {
          id: "work",
          priority: 100,
          inline: direct,
          overflow: {
            ariaLabel: t`Change work for this chat, currently ${work.name}`,
            label: <Trans>Work</Trans>,
            value: work.name,
            onOpen: () => {
              controller.open("overflow");
              controller.openWorks();
            },
            panel: picker,
            onBack: controller.openOverflowRoot,
            size: "picker",
            busy: controller.busy,
            canDismiss: controller.canDismiss,
          },
        },
      ]}
    />
  );
}

function WorkBindingPopoverContent({
  controller,
  label,
  children,
}: {
  controller: ReturnType<typeof useComposerWorkBinding>;
  label: string;
  children: ReactNode;
}) {
  return (
    <PopoverContent
      align="start"
      aria-label={label}
      aria-busy={controller.busy}
      className="work-selector-popover flex w-80 flex-col overflow-hidden p-3"
      onEscapeKeyDown={(event) => {
        if (!controller.canDismiss) event.preventDefault();
      }}
      onPointerDownOutside={(event) => {
        if (!controller.canDismiss) event.preventDefault();
      }}
    >
      {children}
    </PopoverContent>
  );
}
