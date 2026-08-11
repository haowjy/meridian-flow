import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ArrowLeft, ChevronRight, Ellipsis } from "lucide-react";
import { type ReactNode, useCallback, useId, useLayoutEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useDensityPopoverCollisionProps } from "@/components/ui/density-popover-collision";
import {
  dropdownRowVariants,
  dropdownSurfaceVariants,
} from "@/components/ui/dropdown-presentation";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { deriveToolbarView } from "./composer-toolbar-navigation";
import type {
  ComposerToolbarControl,
  ComposerToolbarModel,
  ComposerToolbarPanelContext,
  ComposerToolbarTriggerBinding,
  PanelSession,
} from "./types";
import { useComposerToolbarMachine } from "./useComposerToolbarMachine";
import { useMeasuredComposerToolbar } from "./useMeasuredComposerToolbar";

function RootRowText({ label, value }: { label: ReactNode; value?: ReactNode }) {
  return (
    <>
      <span data-slot="composer-root-row-label" className="min-w-0 flex-1 truncate">
        {label}
      </span>
      <span
        data-slot="composer-root-row-value"
        className="min-w-0 flex-1 truncate text-right text-muted-foreground"
      >
        {value}
      </span>
    </>
  );
}

function eligible(node: HTMLElement | null | undefined, allowAriaDisabled = false) {
  if (!node?.isConnected || node.closest("[inert], [aria-hidden='true']")) return false;
  if (node.matches(":disabled") || (!allowAriaDisabled && node.matches("[aria-disabled='true']")))
    return false;
  const style = getComputedStyle(node);
  return style.display !== "none" && style.visibility !== "hidden";
}

function focusVerified(node: HTMLElement | null | undefined, allowAriaDisabled = false) {
  if (!node || !eligible(node, allowAriaDisabled)) return false;
  const target = node;
  target.focus({ preventScroll: true });
  return document.activeElement === target || Boolean(target.contains(document.activeElement));
}

export function ComposerToolbar({
  model,
  ariaLabel,
}: {
  model: ComposerToolbarModel;
  ariaLabel: string;
}) {
  const { controls, input } = model;
  const [state, dispatch] = useComposerToolbarMachine(input);
  const densityPopoverCollisionProps = useDensityPopoverCollisionProps();
  const contentId = useId();
  const onLayout = useCallback(
    (layout: typeof state.layout) => dispatch({ type: "layout.measured", layout }),
    [dispatch],
  );
  const measurementRevision = controls.map(({ id, priority }) => `${id}:${priority}`).join("\0");
  const measurementRef = useRef({
    revision: measurementRevision,
    controls: controls.map(({ id, priority }) => ({ id, priority })),
  });
  if (measurementRef.current.revision !== measurementRevision)
    measurementRef.current = {
      revision: measurementRevision,
      controls: controls.map(({ id, priority }) => ({ id, priority })),
    };
  const measurement = measurementRef.current.controls;
  const locked = state.surface.kind === "panel" && state.surface.lock === "nondismissible";
  const { root, probe, controlRef } = useMeasuredComposerToolbar(measurement, onLayout, locked);
  const inlineOwners = useRef(new Map<string, HTMLElement>());
  const rootRows = useRef(new Map<string, HTMLButtonElement>());
  const overflowTrigger = useRef<HTMLButtonElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const toolbarFallback = useRef<HTMLFieldSetElement | null>(null);
  const stateRef = useRef(state);
  const descriptorsRef = useRef(controls);
  stateRef.current = state;
  descriptorsRef.current = controls;
  const view = deriveToolbarView(state);
  const overflow = controls.filter((control) => state.layout.overflowIds.includes(control.id));
  const surfacePanel = state.surface.kind === "panel" ? state.surface.panel : null;
  const active = surfacePanel
    ? controls.find(
        (control): control is Extract<ComposerToolbarControl, { kind: "panel" }> =>
          control.id === surfacePanel.controlId && control.kind === "panel",
      )
    : undefined;
  const panel = active?.panel ?? null;
  const anchorHost = view.kind === "inline" ? `inline:${view.controlId}` : view.kind;
  const resolveAnchorHost = () => {
    const currentView = deriveToolbarView(stateRef.current);
    return currentView.kind === "inline"
      ? inlineOwners.current.get(currentView.controlId)
      : overflowTrigger.current;
  };
  const virtualRef = useMemo(
    () => ({
      current: {
        get contextElement() {
          return resolveAnchorHost();
        },
        getBoundingClientRect: () => resolveAnchorHost()?.getBoundingClientRect() ?? new DOMRect(),
      },
    }),
    // A new virtual element makes Radix re-register its reference after the new host commits.
    [anchorHost],
  );
  const commands = (session: PanelSession): ComposerToolbarPanelContext => ({
    host: view.kind === "inline" ? "inline" : "overflow",
    locked,
    panel: session,
    requestDismiss: () => {
      if (locked) return "refused";
      dispatch({ type: "panel.dismissRequested", panel: session, cause: "programmatic" });
      return "closed";
    },
    beginBlocking: () => {
      if (locked) return { kind: "refused" };
      dispatch({ type: "panel.blockingStarted", panel: session });
      return {
        kind: "started",
        settle: (outcome) => dispatch({ type: "panel.blockingSettled", panel: session, outcome }),
      };
    },
    terminalClose: () => dispatch({ type: "panel.terminalClose", panel: session }),
  });

  const firstInlineOwner = () =>
    stateRef.current.layout.inlineIds
      .map((id) => inlineOwners.current.get(id))
      .find((node) => eligible(node, true));
  const returnCandidates = (controlId: string) => [
    inlineOwners.current.get(controlId),
    overflowTrigger.current,
    firstInlineOwner(),
    toolbarFallback.current,
  ];
  const executePendingFocus = useCallback(() => {
    const currentState = stateRef.current;
    const intent = currentState.focus;
    if (!intent) return;
    const target = intent.target;
    if (target.kind === "panel.repair") {
      const activeElement = document.activeElement as HTMLElement | null;
      if (content.current?.contains(activeElement) && eligible(activeElement)) {
        dispatch({ type: "focus.executed", token: intent.token });
        return;
      }
    }
    let candidates: Array<HTMLElement | null | undefined>;
    if (target.kind === "panel.enter" || target.kind === "panel.repair") {
      const descriptor = descriptorsRef.current.find(
        (control): control is Extract<ComposerToolbarControl, { kind: "panel" }> =>
          control.id === target.panel.controlId && control.kind === "panel",
      );
      candidates = [
        ...(descriptor?.panel.focus.candidates.map(({ ref }) => ref.current) ?? []),
        content.current,
      ].filter(
        (node) => !node || Boolean(content.current?.contains(node)) || node === content.current,
      );
    } else if (target.kind === "control.owner") candidates = returnCandidates(target.controlId);
    else if (target.kind === "root.row")
      candidates = [rootRows.current.get(target.controlId), content.current];
    else if (target.kind === "overflow.trigger")
      candidates = [overflowTrigger.current, firstInlineOwner(), toolbarFallback.current];
    else if (target.kind === "root.content") candidates = [content.current];
    else candidates = [firstInlineOwner(), toolbarFallback.current];
    for (const candidate of candidates) {
      if (!focusVerified(candidate, target.kind === "control.owner")) continue;
      dispatch({ type: "focus.executed", token: intent.token });
      return;
    }
  }, [dispatch]);
  const contentRef = useCallback(
    (node: HTMLDivElement | null) => {
      content.current = node;
      if (node) executePendingFocus();
    },
    [executePendingFocus],
  );
  useLayoutEffect(() => executePendingFocus(), [state.focus, executePendingFocus]);

  const registerInline = (id: string) => (node: HTMLElement | null) => {
    if (node) inlineOwners.current.set(id, node);
    else inlineOwners.current.delete(id);
  };
  const triggerBinding = (
    control: Extract<ComposerToolbarControl, { kind: "panel" }>,
    owner: "inline" | "root-row",
  ): ComposerToolbarTriggerBinding => {
    const openForControl =
      state.surface.kind === "panel" && state.surface.panel.controlId === control.id;
    const ownsContent =
      view.kind !== "closed" &&
      (owner === "root-row" || view.kind === "inline") &&
      (owner === "root-row" ? state.surface.kind === "root" : openForControl);
    const refused = control.interaction === "busy" || locked;
    return {
      ref: (node) => {
        if (owner === "inline") registerInline(control.id)(node);
        else if (node) rootRows.current.set(control.id, node);
        else rootRows.current.delete(control.id);
      },
      buttonProps: {
        "aria-haspopup": "dialog",
        "aria-controls": ownsContent ? contentId : undefined,
        "aria-expanded": owner === "inline" && openForControl && view.kind === "inline",
        "aria-busy": control.interaction === "busy" ? true : undefined,
        "aria-disabled": refused ? true : undefined,
        onClick: () => {
          if (refused) return;
          dispatch({ type: "panel.triggered", controlId: control.id });
        },
      },
    };
  };

  const activeBusy = active?.interaction === "busy";
  return (
    <Popover
      open={view.kind !== "closed"}
      onOpenChange={(next) => {
        if (!next && state.surface.kind === "root")
          dispatch({ type: "root.dismissRequested", cause: "outside" });
      }}
    >
      <fieldset
        ref={(node) => {
          root.current = node;
          toolbarFallback.current = node;
        }}
        tabIndex={-1}
        aria-label={ariaLabel}
        className="relative flex min-w-0 items-center gap-2 overflow-clip border-0"
      >
        {controls.map((control) => {
          const hidden = state.layout.overflowIds.includes(control.id);
          return (
            <span
              key={control.id}
              ref={(node) => controlRef(control.id)(node)}
              inert={hidden ? true : undefined}
              aria-hidden={hidden || undefined}
              className={cn(
                "inline-flex w-max min-w-0 flex-none overflow-hidden [&>button]:max-w-full",
                hidden && "pointer-events-none invisible absolute left-0 top-0",
              )}
            >
              {control.kind === "panel"
                ? control.inline({ trigger: triggerBinding(control, "inline") })
                : control.inline({ controlRef: registerInline(control.id) })}
            </span>
          );
        })}
        {overflow.length ? (
          <Button
            ref={overflowTrigger}
            variant="quiet"
            size="icon-lg"
            type="button"
            aria-label={t`More composer controls`}
            aria-haspopup="dialog"
            aria-controls={view.kind === "overflow" ? contentId : undefined}
            aria-expanded={view.kind === "overflow"}
            aria-busy={view.kind === "overflow" && activeBusy ? true : undefined}
            aria-disabled={view.kind === "overflow" && locked ? true : undefined}
            onClick={() => {
              if (!locked) dispatch({ type: "root.triggered" });
            }}
          >
            <Ellipsis className="size-4" aria-hidden />
          </Button>
        ) : null}
        <Button
          ref={probe}
          variant="quiet"
          size="icon-lg"
          type="button"
          tabIndex={-1}
          inert
          aria-hidden
          className="pointer-events-none invisible absolute left-0 top-0"
        >
          <Ellipsis className="size-4" />
        </Button>
      </fieldset>
      <PopoverAnchor virtualRef={virtualRef} />
      {view.kind !== "closed" ? (
        <PopoverContent
          {...densityPopoverCollisionProps}
          id={contentId}
          ref={contentRef}
          tabIndex={-1}
          align="start"
          side="top"
          aria-label={panel?.ariaLabel ?? t`More composer controls`}
          aria-busy={locked || activeBusy || undefined}
          data-page={panel ? panel.focus.pageId : "root"}
          className={dropdownSurfaceVariants({
            measure: panel?.size ?? "compact",
            page: !panel || panel.size === "compact" ? "navigation" : "picker",
          })}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            if (state.surface.kind === "panel")
              dispatch({
                type: "panel.dismissRequested",
                panel: state.surface.panel,
                cause: "escape",
              });
            else dispatch({ type: "root.dismissRequested", cause: "escape" });
          }}
          onPointerDownOutside={(event) => {
            event.preventDefault();
            if (root.current?.contains(event.target as Node)) return;
            if (state.surface.kind === "panel")
              dispatch({
                type: "panel.dismissRequested",
                panel: state.surface.panel,
                cause: "outside",
              });
            else dispatch({ type: "root.dismissRequested", cause: "outside" });
          }}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            executePendingFocus();
          }}
        >
          {state.surface.kind === "panel" && panel ? (
            <>
              {view.kind === "overflow" ? (
                <Button
                  variant="quiet"
                  className={cn(dropdownRowVariants(), "mb-2 justify-start")}
                  aria-disabled={locked || undefined}
                  onClick={() => {
                    if (!locked && state.surface.kind === "panel")
                      dispatch({ type: "panel.backRequested", panel: state.surface.panel });
                  }}
                >
                  <ArrowLeft className="size-4" aria-hidden />
                  <Trans>Back</Trans>
                </Button>
              ) : null}
              {panel.render(commands(state.surface.panel))}
            </>
          ) : (
            <ul>
              {overflow.map((control) => (
                <li key={control.id}>
                  {control.kind === "status" ? (
                    <div className={dropdownRowVariants({ interactive: false })}>
                      {control.item.icon}
                      <RootRowText label={control.item.label} value={control.item.value} />
                    </div>
                  ) : (
                    <Button
                      {...triggerBinding(control, "root-row").buttonProps}
                      ref={triggerBinding(control, "root-row").ref}
                      variant="ghost"
                      className={dropdownRowVariants()}
                      aria-label={control.item.ariaLabel}
                      onFocus={() => dispatch({ type: "root.rowFocused", controlId: control.id })}
                    >
                      {control.item.icon}
                      <RootRowText label={control.item.label} value={control.item.value} />
                      <ChevronRight className="size-4 shrink-0" aria-hidden />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </PopoverContent>
      ) : null}
    </Popover>
  );
}
