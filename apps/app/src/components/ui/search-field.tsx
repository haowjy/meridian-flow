import { t } from "@lingui/core/macro";
import { Search, X } from "lucide-react";
import { type Ref, useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** The one search box: pickers' and lists' filters. Its label is also the placeholder. */
export function SearchField({
  ref,
  value,
  onChange,
  label,
  disabled,
  onSubmit,
  listItem,
  className,
}: {
  ref?: Ref<HTMLInputElement>;
  value: string;
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  /** Enter in the field: a picker whose first result is the obvious choice picks it. */
  onSubmit?: () => void;
  /** Takes part in its list's arrow keys (`handleListKeys`). */
  listItem?: boolean;
  /** Its placement in the host. */
  className?: string;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <div className={cn("relative min-w-0", className)}>
      <Search
        className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        data-list-item={listItem || undefined}
        ref={(node) => {
          input.current = node;
          if (typeof ref === "function") return ref(node);
          if (ref) ref.current = node;
        }}
        type="search"
        value={value}
        disabled={disabled}
        aria-label={label}
        placeholder={label}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={
          onSubmit
            ? (event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                onSubmit();
              }
            : undefined
        }
        // The browser's own clear button takes the platform's accent; this one takes ours.
        className="h-8 pr-7 pl-8 coarse:h-11 coarse:pr-11 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {value && !disabled ? (
        <button
          type="button"
          aria-label={t`Clear search`}
          title={t`Clear search`}
          onClick={() => {
            onChange("");
            input.current?.focus();
          }}
          className="focus-ring absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground coarse:size-11 coarse:right-0"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * A search box that keeps keystrokes to itself and reports only the settled value, so typing
 * never re-renders the list it filters; see `useSettledSearch`.
 */
export function SettledSearchField({
  value,
  onSettle,
  ...field
}: Omit<Parameters<typeof SearchField>[0], "value" | "onChange"> & {
  value: string | null;
  onSettle: (value: string | null) => void;
}) {
  const [text, setText] = useSettledSearch(value, onSettle);
  return <SearchField {...field} value={text} onChange={setText} />;
}

/**
 * Reports the trimmed text (null when empty) 200ms after typing stops, at
 * once when cleared. Resyncs from an outside change to `settled` (Back or
 * Forward) without clobbering text the writer is still typing.
 */
function useSettledSearch(
  settled: string | null,
  onSettle: (value: string | null) => void,
): [string, (text: string) => void] {
  const [text, setText] = useState(settled ?? "");
  const lastSettled = useRef(settled ?? "");
  useEffect(() => {
    if ((settled ?? "") !== lastSettled.current) {
      lastSettled.current = settled ?? "";
      setText(settled ?? "");
    }
  }, [settled]);
  useEffect(() => {
    const next = text.trim();
    const timer = window.setTimeout(
      () => {
        lastSettled.current = next;
        onSettle(next || null);
      },
      next ? 200 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [text, onSettle]);
  return [text, setText];
}
