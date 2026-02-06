import { Search, X } from "lucide-react";
import { Input } from "@/shared/components/ui/input";
import { useUIStore } from "@/core/stores/useUIStore";
import { useCallback } from "react";

interface ProjectSearchInputProps {
  autoFocus?: boolean;
  onRequestClose?: () => void;
}

export function ProjectSearchInput({
  autoFocus,
  onRequestClose,
}: ProjectSearchInputProps) {
  const query = useUIStore((state) => state.projectSearchQuery);
  const setQuery = useUIStore((state) => state.setProjectSearchQuery);

  const handleClear = useCallback(() => {
    setQuery("");
  }, [setQuery]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        // On the projects page, search is a transient UI affordance: Esc closes it.
        // This avoids trapping the user in "search mode", especially on mobile.
        if (onRequestClose) {
          onRequestClose();
          return;
        }
        handleClear();
      }
    },
    [handleClear, onRequestClose],
  );

  return (
    <div className="relative w-full max-w-md">
      <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
      <Input
        autoFocus={autoFocus}
        type="text"
        placeholder="Search projects..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        className="pr-9 pl-10 placeholder:opacity-50"
      />
      {query && (
        <button
          onClick={handleClear}
          className="absolute top-1/2 right-3 -translate-y-1/2 rounded p-0.5 transition-colors hover:bg-[var(--hover)]"
          aria-label="Clear search"
        >
          <X className="text-muted-foreground size-3.5" />
        </button>
      )}
    </div>
  );
}
