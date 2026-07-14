/**
 * Composer — shared chat input surface used by home and pinned chat footers.
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
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type ComposerProps = {
  /** Called with the trimmed message text when the user submits a non-empty draft. */
  onSubmit: (text: string) => void;
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
  /** Focus the textarea on mount (the Home hero uses this). */
  autoFocus?: boolean;
  /**
   * Visual treatment. `hero` is the prominent Home surface (large shadow, taller
   * default height); `pinned` is the compact footer used by the ChatView in
   * Phase 3. Behaviour is identical across variants.
   */
  variant?: "hero" | "pinned";
  /** Footer toolbar slot for caller-owned controls such as the agent selector. */
  toolbarLeft?: ReactNode;
  /**
   * Drop the composer's own border/rounding/shadow so it can sit flush inside a
   * shared outer container (the DraftDock composer-unit box). Pinned only.
   */
  flush?: boolean;
};

/** Imperative handle exposed by ref so ChatView can focus the textarea. */
export type ComposerHandle = {
  focus: () => void;
};

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
    onStop,
    streaming = false,
    placeholder,
    autoFocus = false,
    variant = "hero",
    toolbarLeft,
    flush = false,
  },
  ref,
) {
  // Default placeholder is computed inside the component so the catalog lookup
  // is locale-live (the default-value form would freeze it at parse time).
  const resolvedPlaceholder = placeholder ?? t`Ask anything…`;
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSend = text.trim().length > 0;

  // Expose a focus() handle to parent components (e.g. ChatView).
  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }));

  // Resize after React commits `text` — including post-submit clear. Synchronous
  // resize in submit() measured stale DOM content (controlled value not flushed yet).
  useEffect(() => {
    const el = textareaRef.current;
    if (el) resizeComposerTextarea(el);
  }, [text]);

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setText(event.target.value);
    resizeComposerTextarea(event.target);
  }

  function submit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setText("");
    // Keep focus for a fast follow-up message.
    textareaRef.current?.focus();
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
      if (!streaming) submit();
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      // While a turn is streaming, Enter is inert — the action button is "stop".
      if (!streaming) submit();
    }
  }

  return (
    <div
      className={cn(
        "px-4 pt-4 pb-3",
        // Hero floats on the manuscript page as a raised lift surface; the
        // pinned composer sits flush on the warm dock as a recessed field —
        // surface-warm reads as a warm field on BOTH the bright page and the
        // chrome, so callers don't need a per-context fill. `flush` hands the
        // border/radius/shadow to a shared outer box (DraftDock composer-unit).
        flush
          ? "bg-surface-warm"
          : "border border-border transition-[border-color,box-shadow] focus-within:border-border-focus",
        !flush &&
          (variant === "hero"
            ? "bg-card rounded-composer shadow-hero"
            : "bg-surface-warm rounded-composer-pinned shadow-input"),
      )}
    >
      <Textarea
        ref={textareaRef}
        value={text}
        autoFocus={autoFocus}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={resolvedPlaceholder}
        rows={1}
        // Force field-sizing: fixed so our JS auto-resize has full control.
        // The upstream shadcn Textarea uses field-sizing-content; tailwind-merge
        // v2.6.1 does not merge the two classes so both end up on the element.
        style={{ fieldSizing: "fixed" }}
        className={cn(
          // No focus treatment of its own: the composer box (focus-within
          // border above) is the field — the inner textarea must not add a
          // second indicator.
          "composer-input field-sizing-fixed resize-none border-0 bg-transparent px-1.5 py-1 outline-none",
          "dark:bg-transparent",
          "max-h-60 overflow-y-auto placeholder:text-muted-foreground",
          variant === "hero" ? "min-h-[52px]" : "min-h-[40px]",
        )}
      />

      <div className="mt-1 flex items-center gap-2">
        {toolbarLeft}

        <div className="flex-1" />

        <Button
          type="button"
          size="icon-sm"
          onClick={() => (streaming ? onStop?.() : submit())}
          disabled={streaming ? false : !canSend}
          aria-label={streaming ? t`Stop` : t`Send message`}
          className={cn(
            "focus-ring transition-all duration-200 ease-out",
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
      </div>
    </div>
  );
});
