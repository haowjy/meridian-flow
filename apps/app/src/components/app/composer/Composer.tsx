/**
 * Composer — shared message input presentation for Home and chat surfaces.
 * It owns textarea growth, keyboard submit/stop behaviour, and the send control
 * while callers own message dispatch and streaming state.
 */
import { t } from "@lingui/core/macro";
import { ArrowUp } from "lucide-react";
import {
  type ChangeEvent,
  forwardRef,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { useComposerPlaceholder } from "./placeholders";

export type ComposerProps = {
  /** Clear only when the caller accepts ownership of the exact submitted text. */
  onSubmit: (text: string, revision: number) => boolean | Promise<boolean>;
  /** Reports the live draft and its authoring revision for navigation handoffs. */
  onDraftChange?: (text: string, revision: number) => void;
  /** Called when the user clicks the stop control while a turn is running. */
  onStop?: () => void;
  /**
   * True while an assistant turn is streaming. Flips the action button from the
   * square "send" control into the circular "stop" control, and disables
   * Enter-to-submit. Defaults to false. (Phase 3's ChatView wires this.)
   */
  streaming?: boolean;
  /** Placeholder shown while the draft is empty. */
  placeholder?: string;
  /** Focus the textarea on mount (Home uses this for fine pointers). */
  autoFocus?: boolean;
  /**
   * Layout treatment. Home uses the roomier `hero` input height while Chat uses
   * `pinned`; both share the same ordinary, shadowless Composer surface.
   */
  variant?: "hero" | "pinned";
  /** Footer toolbar slot for caller-owned controls such as the agent selector. */
  toolbarLeft?: ReactNode;
  /** Caller-owned readiness gate; the draft remains editable and intact. */
  submitDisabled?: boolean;
  /** Caller-owned operation state; does not replace the visible draft. */
  busy?: boolean;
  /** Localized explanation associated with a disabled Send control. */
  submitDisabledReason?: string;
};

export type ComposerDraftRestoration = {
  id: string;
  text: string;
};

/** Imperative handle exposed by ref so ChatView can focus the textarea. */
export type ComposerHandle = {
  focus: () => void;
  getDraft: () => string;
  /** Restore a failed handoff as a new draft revision and acknowledge delivery. */
  restoreDraft: (restoration: ComposerDraftRestoration) => boolean;
};

export function mergeRestoredComposerDraft(restoredText: string, currentText: string): string {
  if (!currentText || currentText === restoredText) return restoredText;
  return `${restoredText}\n\n${currentText}`;
}

function resizeComposerTextarea(el: HTMLTextAreaElement) {
  const maxHeight = Number.parseInt(getComputedStyle(el).maxHeight, 10);
  const cap = Number.isFinite(maxHeight) ? maxHeight : 240;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
}

/**
 * The shared notebook composer: an auto-growing textarea with a send button
 * that morphs from a rounded square (send) into a circle (stop) while a turn is
 * streaming. Enter submits; Shift+Enter inserts a newline; Cmd/Ctrl+Enter always
 * submits; Esc cancels a running stream. Clears after a successful submit.
 *
 * This phase has NO model selector. The ChatView reuses this component
 * (variant="pinned") in Phase 3, so keep the prop surface stable.
 */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    onSubmit,
    onDraftChange,
    onStop,
    streaming = false,
    placeholder,
    autoFocus = false,
    variant = "hero",
    toolbarLeft,
    submitDisabled = false,
    busy = false,
    submitDisabledReason,
  },
  ref,
) {
  const rotatingPlaceholder = useComposerPlaceholder(streaming);
  const resolvedPlaceholder = placeholder ?? rotatingPlaceholder;
  const [text, setText] = useState("");
  const textRef = useRef("");
  const draftRevisionRef = useRef(0);
  const submissionInFlightRef = useRef(false);
  const restoredDraftIdsRef = useRef(new Set<string>());
  const [submissionInFlight, setSubmissionInFlight] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const disabledReasonId = useId();
  const canSend = text.trim().length > 0 && !submitDisabled && !submissionInFlight;

  // Expose a focus() handle to parent components (e.g. ChatView).
  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    getDraft: () => textRef.current,
    restoreDraft: ({ id, text: restoredText }) => {
      if (restoredDraftIdsRef.current.has(id)) return true;
      restoredDraftIdsRef.current.add(id);
      const mergedText = mergeRestoredComposerDraft(restoredText, textRef.current);
      draftRevisionRef.current += 1;
      textRef.current = mergedText;
      setText(mergedText);
      onDraftChange?.(mergedText, draftRevisionRef.current);
      textareaRef.current?.focus();
      return true;
    },
  }));

  // Resize after React commits `text` — including post-submit clear. Synchronous
  // resize in submit() measured stale DOM content (controlled value not flushed yet).
  useEffect(() => {
    const el = textareaRef.current;
    if (el) resizeComposerTextarea(el);
  }, [text]);

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    draftRevisionRef.current += 1;
    textRef.current = event.target.value;
    setText(event.target.value);
    onDraftChange?.(event.target.value, draftRevisionRef.current);
    resizeComposerTextarea(event.target);
  }

  async function submit() {
    if (submitDisabled || submissionInFlightRef.current) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const revisionAtSubmit = draftRevisionRef.current;
    submissionInFlightRef.current = true;
    setSubmissionInFlight(true);
    try {
      let accepted = false;
      try {
        accepted = await onSubmit(trimmed, revisionAtSubmit);
      } catch {
        // The caller owns operation errors; a rejected acceptance retains the draft.
      }
      if (accepted && draftRevisionRef.current === revisionAtSubmit) {
        textRef.current = "";
        setText("");
      }
      if (accepted) textareaRef.current?.focus();
    } finally {
      submissionInFlightRef.current = false;
      setSubmissionInFlight(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Esc cancels the stream when streaming.
    if (event.key === "Escape" && streaming) {
      event.preventDefault();
      onStop?.();
      return;
    }

    // Cmd/Ctrl+Enter always submits (multiline-friendly).
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (!streaming) void submit();
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      // While a turn is streaming, Enter is inert — the action button is "stop".
      if (!streaming) void submit();
    }
  }

  const containerClassName = cn(
    "border border-composer-border bg-composer-surface transition-[border-color] focus-within:border-border-focus",
    variant === "hero" ? "rounded-composer" : "rounded-composer-pinned",
  );

  return (
    <div className={cn("px-4 pt-4 pb-3", containerClassName)} aria-busy={busy || undefined}>
      <Textarea
        ref={textareaRef}
        value={text}
        autoFocus={autoFocus}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={resolvedPlaceholder}
        aria-label={t`Message`}
        rows={1}
        // Force field-sizing: fixed so our JS auto-resize has full control.
        // Inline style intentionally overrides the base Textarea's
        // field-sizing-content class.
        style={{ fieldSizing: "fixed" }}
        className={cn(
          // No focus treatment of its own: the composer box (focus-within
          // border above) is the field — the inner textarea must not add a
          // second indicator.
          "composer-input resize-none border-0 bg-transparent px-1.5 py-1 outline-none",
          "max-h-60 overflow-y-auto placeholder:text-muted-foreground",
          variant === "hero" ? "min-h-[52px]" : "min-h-[40px]",
        )}
      />

      <div className="mt-1 flex items-center gap-2">
        <div className="min-w-0 flex-1">{toolbarLeft}</div>

        <Button
          type="button"
          size="icon-sm"
          onClick={() => (streaming ? onStop?.() : void submit())}
          disabled={streaming ? false : !canSend}
          aria-label={streaming ? t`Stop` : t`Send message`}
          aria-describedby={!streaming && submitDisabledReason ? disabledReasonId : undefined}
          className={cn(
            "transition-all duration-200 ease-out [@media(pointer:coarse)]:size-11",
            // Rounded square at rest (send) → circle while running (stop). Height
            // matches the toolbar's other controls (sm / 32px).
            streaming ? "rounded-full" : "rounded-field",
          )}
        >
          {streaming ? (
            <span className="size-2.5 rounded-[3px] bg-primary-foreground" />
          ) : (
            <ArrowUp className="size-4" />
          )}
        </Button>
        {!streaming && submitDisabledReason ? (
          <span id={disabledReasonId} className="sr-only">
            {submitDisabledReason}
          </span>
        ) : null}
      </div>
    </div>
  );
});
