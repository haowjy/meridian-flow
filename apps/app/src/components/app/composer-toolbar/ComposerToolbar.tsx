import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ArrowLeft, ChevronRight, Ellipsis } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { PanelSession } from "./composer-toolbar-navigation";
import {
  deriveToolbarView,
  initialNavigationState,
  reduceNavigation,
} from "./composer-toolbar-navigation";
import type { ComposerToolbarControl, ComposerToolbarPanelContext } from "./types";
import { useMeasuredComposerToolbar } from "./useMeasuredComposerToolbar";

export function ComposerToolbar({
  controls,
  ariaLabel,
}: {
  controls: readonly ComposerToolbarControl[];
  ariaLabel: string;
}) {
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  const [state, dispatchBase] = useReducer(
    (s: ReturnType<typeof initialNavigationState>, e: Parameters<typeof reduceNavigation>[1]) =>
      reduceNavigation(s, e, controlsRef.current),
    controls,
    initialNavigationState,
  );
  const dispatch = dispatchBase;
  const onLayout = useCallback(
    (layout: ReturnType<typeof initialNavigationState>["layout"]) =>
      dispatch({ type: "layout.measured", layout }),
    [],
  );
  const { root, probe, controlRef } = useMeasuredComposerToolbar(controls, onLayout);
  const inlineTriggers = useRef(new Map<string, HTMLElement>());
  const rootRows = useRef(new Map<string, HTMLButtonElement>());
  const overflowTrigger = useRef<HTMLButtonElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const view = deriveToolbarView(state);
  const overflow = controls.filter((c) => state.layout.overflowIds.includes(c.id));
  const surfacePanel = state.surface.kind === "panel" ? state.surface.panel : null;
  const active = surfacePanel ? controls.find((c) => c.id === surfacePanel.controlId) : undefined;
  const panel = active?.overflow.kind === "panel" ? active.overflow.panel : null;
  const locked = state.surface.kind === "panel" && state.surface.lock === "nondismissible";
  const activeId = state.surface.kind === "panel" ? state.surface.panel.controlId : null;
  const anchorNode =
    view.kind === "inline" ? inlineTriggers.current.get(view.controlId) : overflowTrigger.current;
  const virtualRef = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => anchorNode?.getBoundingClientRect() ?? new DOMRect(),
      },
    }),
    [anchorNode],
  );
  const resultFor = (before: typeof state, id: string) => {
    if (before.surface.kind === "panel" && before.surface.lock === "nondismissible")
      return "refused" as const;
    return before.surface.kind === "panel" && before.surface.panel.controlId === id
      ? ("closed" as const)
      : ("opened" as const);
  };
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
        settle: (outcome: "close" | "stay") =>
          dispatch({ type: "panel.blockingSettled", panel: session, outcome }),
      };
    },
    terminalClose: () => dispatch({ type: "panel.terminalClose", panel: session }),
  });
  useLayoutEffect(() => {
    const intent = state.focus;
    if (!intent) return;
    const target = intent.target;
    let node: HTMLElement | null | undefined;
    if (target.kind === "panel.initial")
      node =
        controls.find((c) => c.id === target.panel.controlId && c.overflow.kind === "panel")
          ?.overflow.kind === "panel"
          ? (
              controls.find((c) => c.id === target.panel.controlId)?.overflow as Extract<
                ComposerToolbarControl["overflow"],
                { kind: "panel" }
              >
            ).panel.initialFocusRef.current
          : null;
    else if (target.kind === "control.visibleTrigger")
      node = state.layout.inlineIds.includes(target.controlId)
        ? inlineTriggers.current.get(target.controlId)
        : overflowTrigger.current;
    else if (target.kind === "root.row")
      node = rootRows.current.get(target.controlId) ?? content.current;
    else if (target.kind === "overflow.trigger") node = overflowTrigger.current;
    else node = content.current;
    node?.focus({ preventScroll: true });
    dispatch({ type: "focus.executed", token: intent.token });
  }, [state.focus, state.layout.inlineIds, controls]);
  return (
    <Popover
      open={view.kind !== "closed"}
      onOpenChange={(next) => {
        if (!next && state.surface.kind === "root")
          dispatch({ type: "root.dismissRequested", cause: "outside" });
      }}
    >
      <fieldset
        ref={root}
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
                "inline-flex w-max flex-none",
                hidden && "pointer-events-none invisible absolute left-0 top-0",
              )}
            >
              {control.inline({
                active: activeId === control.id,
                locked: activeId === control.id && locked,
                triggerRef: (node) => {
                  if (node) inlineTriggers.current.set(control.id, node);
                  else inlineTriggers.current.delete(control.id);
                },
                activate: () => {
                  const result = resultFor(state, control.id);
                  dispatch({ type: "panel.triggered", controlId: control.id });
                  return result;
                },
                beginBlocking: () => {
                  if (locked) return { kind: "refused" };
                  dispatch({ type: "panel.blockingTriggered", controlId: control.id });
                  const session = state.nextPanelSession;
                  return {
                    kind: "started",
                    settle: (outcome) =>
                      dispatch({
                        type: "panel.blockingSettled",
                        panel: { controlId: control.id, session },
                        outcome,
                      }),
                  };
                },
              })}
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
            aria-expanded={view.kind === "overflow"}
            aria-busy={locked}
            onClick={() => dispatch({ type: "root.triggered" })}
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
          ref={content}
          tabIndex={-1}
          align="start"
          side="top"
          aria-label={panel?.ariaLabel ?? t`More composer controls`}
          aria-busy={locked}
          data-page={panel ? "panel" : "root"}
          className={cn(
            "composer-overflow-surface w-auto flex flex-col overflow-hidden",
            panel?.size === "picker"
              ? "[--composer-overflow-page-size:20rem] p-3"
              : "[--composer-overflow-page-size:14rem] p-1",
          )}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            if (state.surface.kind === "panel")
              dispatch({
                type: "panel.dismissRequested",
                panel: state.surface.panel,
                cause: "escape",
              });
            else dispatch({ type: "root.dismissRequested", cause: "escape" });
          }}
          onPointerDownOutside={(e) => {
            e.preventDefault();
            if (root.current?.contains(e.target as Node)) return;
            if (state.surface.kind === "panel")
              dispatch({
                type: "panel.dismissRequested",
                panel: state.surface.panel,
                cause: "outside",
              });
            else dispatch({ type: "root.dismissRequested", cause: "outside" });
          }}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {state.surface.kind === "panel" && panel ? (
            <>
              {view.kind === "overflow" ? (
                <Button
                  variant="quiet"
                  className="mb-1 min-h-11 justify-start"
                  disabled={locked}
                  onClick={() =>
                    dispatch({
                      type: "panel.backRequested",
                      panel:
                        state.surface.kind === "panel"
                          ? state.surface.panel
                          : { controlId: "", session: 0 },
                    })
                  }
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
                  {control.overflow.kind === "status" ? (
                    <div className="flex min-h-11 w-full items-center gap-2 px-2">
                      {control.overflow.item.icon}
                      <span>{control.overflow.item.label}</span>
                      <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
                        {control.overflow.item.value}
                      </span>
                    </div>
                  ) : (
                    <Button
                      ref={(n) => {
                        if (n) rootRows.current.set(control.id, n);
                        else rootRows.current.delete(control.id);
                      }}
                      variant="ghost"
                      className="min-h-11 w-full justify-start gap-2 px-2"
                      aria-label={control.overflow.item.ariaLabel}
                      onFocus={() => dispatch({ type: "root.rowFocused", controlId: control.id })}
                      onClick={() => dispatch({ type: "panel.triggered", controlId: control.id })}
                    >
                      {control.overflow.item.icon}
                      <span>{control.overflow.item.label}</span>
                      <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
                        {control.overflow.item.value}
                      </span>
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
