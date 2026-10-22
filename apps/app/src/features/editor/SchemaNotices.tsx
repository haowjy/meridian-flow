/**
 * SchemaNotices — the one-line bars a schema verdict puts above the toolbar.
 *
 * - Fence: this tab's Meridian is older than the chapter, so writing stops
 *   until the writer reloads. Error tone, Refresh on the bar.
 * - Repair: the editor removed prose this version can't display. Writing goes
 *   on. The bar says only that; Details opens the rescued words in a popover,
 *   as wide as the bar, so they never push the manuscript down.
 *
 * One component owns both because Dismiss needs a place to send focus: the
 * editor, or Refresh while the fence holds the editor read-only.
 *
 * Copy is the point of the repair popover: it is the writer's way to keep the
 * words. So it goes through the feature's clipboard adapter and reports a
 * refusal on that fragment. (`CopyTextButton` swallows refusals.)
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Editor } from "@tiptap/core";
import { Check, CircleAlert, Copy, Info } from "lucide-react";
import {
  type ReactNode,
  type Ref,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { SchemaFence } from "@/core/editor/schema-fence";
import type { SchemaRepairEvent } from "@/core/editor/schema-repair-witness";
import { cn } from "@/lib/utils";

import { writeClipboardText } from "./clipboard";

const COPIED_RESET_MS = 1500;

/** A 44px touch target under a coarse pointer, without making the bar taller. */
const BAR_ACTION = "shrink-0 [@media(pointer:coarse)]:-my-2.5 [@media(pointer:coarse)]:h-11";

export function SchemaNotices({
  fence,
  repairs,
  editor,
}: {
  fence: SchemaFence | null;
  repairs: SchemaRepairEvent[];
  editor: Editor | null;
}) {
  const refreshRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <SchemaFenceNotice fence={fence} refreshRef={refreshRef} />
      <SchemaRepairNotice
        repairs={repairs}
        focusAfterDismiss={() => {
          if (fence) refreshRef.current?.focus();
          else if (editor && !editor.isDestroyed) editor.commands.focus();
        }}
      />
    </>
  );
}

function NoticeBar({
  ref,
  tone,
  labelId,
  children,
  action,
  ...data
}: {
  ref?: Ref<HTMLDivElement>;
  tone: "info" | "error";
  labelId?: string;
  children: ReactNode;
  action: ReactNode;
} & Record<`data-${string}`, string>) {
  const Icon = tone === "error" ? CircleAlert : Info;
  return (
    <div
      ref={ref}
      {...data}
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex min-h-8 items-center gap-2 rounded-md border py-1 pr-1 pl-2.5 text-xs",
        tone === "error"
          ? "border-destructive-border bg-destructive-tint text-destructive"
          : "border-border bg-muted text-ink-muted",
      )}
    >
      <Icon aria-hidden className={cn("size-3.5 shrink-0", tone === "info" && "text-ink-subtle")} />
      {/* Wraps rather than truncates on a phone: the reason is the point. */}
      <p id={labelId} className="min-w-0 flex-1">
        {children}
      </p>
      {action}
    </div>
  );
}

function SchemaFenceNotice({
  fence,
  refreshRef,
}: {
  fence: SchemaFence | null;
  refreshRef: RefObject<HTMLButtonElement | null>;
}) {
  if (!fence) return null;
  return (
    <NoticeBar
      tone="error"
      data-schema-fence=""
      data-schema-fence-reason={fence.reason}
      action={
        <Button
          ref={refreshRef}
          type="button"
          variant="outline"
          size="xs"
          className={BAR_ACTION}
          onClick={() => window.location.reload()}
        >
          <Trans>Refresh</Trans>
        </Button>
      }
    >
      <Trans>Editing paused. This chapter needs a newer version of Meridian.</Trans>
    </NoticeBar>
  );
}

function SchemaRepairNotice({
  repairs,
  focusAfterDismiss,
}: {
  repairs: SchemaRepairEvent[];
  /** Dismiss takes the bar, and the Details button focus would return to, away. */
  focusAfterDismiss: () => void;
}) {
  // Dismiss hides what the writer has seen; a later removal grows the list and
  // brings the bar back.
  const [dismissedCount, setDismissedCount] = useState(0);
  const dismissing = useRef(false);
  const labelId = useId();
  if (repairs.length <= dismissedCount) return null;

  return (
    <Popover>
      <PopoverAnchor asChild>
        <NoticeBar
          tone="info"
          labelId={labelId}
          data-schema-repair-notice=""
          action={
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className={BAR_ACTION}
                aria-label={t`Details about removed text`}
              >
                <Trans>Details</Trans>
              </Button>
            </PopoverTrigger>
          }
        >
          <Trans>Some text was removed</Trans>
        </NoticeBar>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        collisionPadding={8}
        aria-labelledby={labelId}
        data-schema-repair-details=""
        // Anchored to the whole bar, so the trigger width is the bar's: the popover
        // stays inside the pane in a narrow dock. The rescued words scroll inside
        // it; it never outgrows the space below the bar.
        className="flex max-h-[min(28rem,var(--radix-popover-content-available-height))] w-[min(30rem,var(--radix-popover-trigger-width))] flex-col gap-3 overflow-y-auto p-3 text-compact"
        onCloseAutoFocus={(event) => {
          // Only the close Dismiss caused: Escape still returns to Details.
          if (!dismissing.current) return;
          dismissing.current = false;
          event.preventDefault();
          focusAfterDismiss();
        }}
      >
        <ol className="flex flex-col gap-2">
          {repairs.map((repair, index) => (
            // Events have no durable id; session append order and detection
            // time together identify one rendering without inventing persistence.
            <RemovedFragment key={`${repair.detectedAt}:${index}`} repair={repair} />
          ))}
        </ol>
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-ink-muted">
            <Trans>This version of Meridian can't display it.</Trans>
          </p>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="shrink-0 [@media(pointer:coarse)]:h-11"
            onClick={() => {
              dismissing.current = true;
              setDismissedCount(repairs.length);
            }}
          >
            <Trans>Dismiss</Trans>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function RemovedFragment({ repair }: { repair: SchemaRepairEvent }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "blocked">("idle");
  const resetRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (resetRef.current !== null) window.clearTimeout(resetRef.current);
    },
    [],
  );
  const text = repair.removedText;

  return (
    <li
      data-schema-repair
      data-schema-repair-phase={repair.phase}
      data-schema-repair-evidence={repair.evidenceDegraded ? "degraded" : "complete"}
      className="flex flex-col gap-1"
    >
      {text ? (
        <>
          <div className="flex items-start gap-2 rounded-md border border-border-subtle bg-background py-1.5 pr-1.5 pl-3">
            <pre
              data-schema-repair-removed-text
              // The rescued words in the reader's font, wrapped and bounded so one
              // long passage doesn't hide the rest of the list.
              className="max-h-32 min-w-0 flex-1 overflow-y-auto py-0.5 font-sans break-words whitespace-pre-wrap text-foreground"
            >
              {text}
            </pre>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="shrink-0 [@media(pointer:coarse)]:h-11"
              data-copy-schema-repair
              onClick={() => {
                void writeClipboardText(text).then((write) => {
                  // A pending Copied reset must not erase a later refusal.
                  if (resetRef.current !== null) window.clearTimeout(resetRef.current);
                  resetRef.current = null;
                  if (write.status !== "done") {
                    setCopy("blocked");
                    return;
                  }
                  setCopy("copied");
                  resetRef.current = window.setTimeout(() => setCopy("idle"), COPIED_RESET_MS);
                });
              }}
            >
              {copy === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copy === "copied" ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
            </Button>
          </div>
          {copy === "blocked" ? (
            <p role="status" data-schema-repair-copy-blocked className="text-destructive">
              <Trans>Couldn't copy. Select the text to copy it.</Trans>
            </p>
          ) : null}
        </>
      ) : (
        // The same box as a rescued passage, so it reads as its own item.
        <p
          data-schema-repair-no-text
          className="rounded-md border border-border-subtle bg-background py-2 pr-1.5 pl-3 text-ink-muted"
        >
          <Trans>This passage couldn't be recovered.</Trans>
        </p>
      )}
    </li>
  );
}
