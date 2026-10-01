/**
 * The project lists' search box, and `SettledSearchField`: a search box that
 * keeps keystrokes to itself and reports only the settled (debounced) value,
 * so typing never re-renders the list it filters.
 */
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";

export function SearchField({
  label,
  value,
  onChange,
}: {
  /** Also the placeholder. */
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        value={value}
        aria-label={label}
        placeholder={label}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 pl-8 [@media(pointer:coarse)]:h-11"
      />
    </div>
  );
}

/** A search box whose settled value alone leaves it; see `useSettledSearch`. */
export function SettledSearchField({
  label,
  value,
  onSettle,
}: {
  label: string;
  value: string | null;
  onSettle: (value: string | null) => void;
}) {
  const [text, setText] = useSettledSearch(value, onSettle);
  return <SearchField label={label} value={text} onChange={setText} />;
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
