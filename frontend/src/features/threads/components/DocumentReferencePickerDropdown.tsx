import { useState } from "react";
import { ChevronLeft, ChevronRight, FileText, Folder, Plus } from "lucide-react";

import { Button } from "@/shared/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/shared/components/ui/dropdown-menu";
import { Input } from "@/shared/components/ui/input";
import { cn } from "@/lib/utils";
import type { ReferenceElementData } from "@/features/threads/composer/inlineElements";

import { useDocumentReferenceSelector } from "./documentReferenceSelectorCore";

interface DocumentReferencePickerDropdownProps {
  disabled?: boolean;
  onAddReferences: (refs: ReferenceElementData[]) => void;
}

export function DocumentReferencePickerDropdown({
  disabled,
  onAddReferences,
}: DocumentReferencePickerDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<"menu" | "docs-files">("menu");
  const { items, documentsCount, getReferencesForItem } =
    useDocumentReferenceSelector(query);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setQuery("");
      setStage("menu");
    }
    setOpen(nextOpen);
  };

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={disabled}
          aria-label="Add context"
          title="Add context"
          className="text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-2">
        {stage === "menu" ? (
          <>
            <DropdownMenuLabel className="px-1 py-1 text-xs font-medium">
              Attach
            </DropdownMenuLabel>
            <DropdownMenuItem
              className="flex items-center gap-2 text-xs"
              onSelect={(e) => {
                e.preventDefault();
                setStage("docs-files");
              }}
            >
              <FileText className="text-muted-foreground size-3.5" />
              <span className="flex-1">Docs and files</span>
              <ChevronRight className="text-muted-foreground size-3.5" />
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <div className="mb-1 flex items-center gap-1 px-1">
              <button
                type="button"
                className="hover:bg-hover inline-flex size-5 items-center justify-center rounded-sm"
                onClick={() => setStage("menu")}
                aria-label="Back"
              >
                <ChevronLeft className="size-3.5" />
              </button>
              <span className="text-muted-foreground text-xs font-medium">
                Docs and files
              </span>
            </div>
            <div className="px-1 pb-1">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search documents..."
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
            <div className="max-h-64 overflow-y-auto px-1 pb-1">
              {documentsCount === 0 ? (
                <div className="text-muted-foreground px-2 py-2 text-xs">
                  No documents yet.
                </div>
              ) : items.length === 0 ? (
                <div className="text-muted-foreground px-2 py-2 text-xs">
                  No matches.
                </div>
              ) : (
                items.map((item) => (
                  <DropdownMenuItem
                    key={`${item.refType}-${item.id}`}
                    className={cn("flex items-center gap-2 text-xs")}
                    onSelect={() => {
                      const refs = getReferencesForItem(item);
                      if (refs.length === 0) return;
                      onAddReferences(refs);
                      setOpen(false);
                    }}
                  >
                    {item.refType === "folder" ? (
                      <Folder className="text-muted-foreground size-3.5 shrink-0" />
                    ) : (
                      <FileText className="text-muted-foreground size-3.5 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{item.name}</div>
                      {item.path !== item.name && (
                        <div className="text-muted-foreground truncate text-[10px]">
                          {item.path}
                        </div>
                      )}
                    </div>
                    {item.refType === "folder" && (
                      <span className="text-muted-foreground text-[10px]">
                        All
                      </span>
                    )}
                  </DropdownMenuItem>
                ))
              )}
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
