/**
 * Composer — shared chat input surface used by home and pinned chat footers.
 * It owns textarea growth, keyboard submit/stop behaviour, and attach/send
 * chrome while callers own message dispatch and streaming state.
 */
import { t } from "@lingui/core/macro";
import { ArrowUp, Paperclip } from "lucide-react";
import {
  type ChangeEvent,
  forwardRef,
  type KeyboardEvent,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ComposerAgentControlProps } from "@/features/agents/ComposerAgentControl";
import { ComposerAgentControl } from "@/features/agents/ComposerAgentControl";
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
  /** Agent chip in the footer left; attach relocates beside send when set. */
  agent?: Omit<ComposerAgentControlProps, "compact"> & { compact?: boolean };
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
 * The shared notebook composer: an auto-growing textarea with a visual attach
 * affordance and a send button that morphs from a rounded square (send) into a
 * circle (stop) while a turn is streaming. Enter submits; Shift+Enter inserts a
 * newline; Cmd/Ctrl+Enter always submits; Esc cancels a running stream. Clears
 * after a successful submit.
 *
 * This phase has NO model selector and NO real upload — the attach control is a
 * visual placeholder. The ChatView reuses this component (variant="pinned") in
 * Phase 3, so keep the prop surface stable.
 */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { onSubmit, onStop, streaming = false, placeholder, autoFocus = false, variant = "hero", agent },
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
        "border border-border px-4 pt-4 pb-3 transition-[border-color,box-shadow] focus-within:border-border-focus",
        // Hero floats on the manuscript page as a raised lift surface; the
        // pinned composer sits flush on the warm dock as a recessed field —
        // surface-warm reads as a warm field on BOTH the bright page and the
        // chrome, so callers don't need a per-context fill.
        variant === "hero"
          ? "bg-card rounded-[18px] shadow-hero"
          : "bg-surface-warm rounded-[14px] shadow-input",
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
          "composer-input field-sizing-fixed focus-ring resize-none border-0 bg-transparent px-1.5 py-1 shadow-none",
          "focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent",
          "max-h-60 overflow-y-auto placeholder:text-muted-foreground",
          variant === "hero" ? "min-h-[52px]" : "min-h-[40px]",
        )}
      />

      <div className="mt-1 flex items-center gap-2">
        {agent ? (
          <ComposerAgentControl
            projectId={agent.projectId}
            mode={agent.mode}
            selectedSlug={agent.selectedSlug}
            onSelectedSlugChange={agent.onSelectedSlugChange}
            compact={agent.compact}
          />
        ) : null}

        <div className="flex-1" />

        <button type="button" aria-label={t`Attach scans or reference files`} className="icon-chip">
          <Paperclip className="size-[18px]" />
        </button>

        <Button
          type="button"
          size="icon"
          onClick={() => (streaming ? onStop?.() : submit())}
          disabled={streaming ? false : !canSend}
          aria-label={streaming ? t`Stop` : t`Send message`}
          className={cn(
            "focus-ring size-9 transition-all duration-200 ease-out",
            // Rounded square at rest (send) → circle while running (stop).
            streaming ? "rounded-full" : "rounded-[12px]",
          )}
        >
          {streaming ? (
            <span className="size-3 rounded-[3px] bg-primary-foreground" />
          ) : (
            <ArrowUp className="size-[18px]" />
          )}
        </Button>
      </div>
    </div>
  );
});
