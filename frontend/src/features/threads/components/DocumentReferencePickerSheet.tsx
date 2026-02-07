import { useState } from "react";
import { ChevronLeft, ChevronRight, FileText, Folder } from "lucide-react";

import { cn } from "@/lib/utils";
import { Input } from "@/shared/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/shared/components/ui/sheet";
import type { ReferenceElementData } from "@/features/threads/composer/inlineElements";

import { useDocumentReferenceSelector } from "./documentReferenceSelectorCore";

interface DocumentReferencePickerSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddReferences: (refs: ReferenceElementData[]) => void;
}

export function DocumentReferencePickerSheet({
  open,
  onOpenChange,
  onAddReferences,
}: DocumentReferencePickerSheetProps) {
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<"menu" | "docs-files">("menu");
  const { items, documentsCount, getReferencesForItem } =
    useDocumentReferenceSelector(query);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setQuery("");
      setStage("menu");
    }
    onOpenChange(nextOpen);
  };

  const addItem = (refs: ReferenceElementData[]) => {
    if (refs.length === 0) return;
    onAddReferences(refs);
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent side="bottom" className="h-[72vh] gap-0 p-0 sm:h-[70vh]">
        <div className="flex min-h-0 flex-1 flex-col">
          {stage === "menu" ? (
            <>
              <SheetHeader className="gap-2 border-b p-3 sm:p-4">
                <SheetTitle>Attach</SheetTitle>
              </SheetHeader>
              <div className="p-2">
                <button
                  type="button"
                  className="hover:bg-hover flex min-h-11 w-full items-center gap-2 rounded-sm px-3 py-2 text-left"
                  onClick={() => setStage("docs-files")}
                >
                  <FileText className="text-muted-foreground size-4 shrink-0" />
                  <span className="flex-1 text-sm">Docs and files</span>
                  <ChevronRight className="text-muted-foreground size-4 shrink-0" />
                </button>
              </div>
            </>
          ) : (
            <>
              <SheetHeader className="gap-2 border-b p-3 sm:p-4">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="hover:bg-hover inline-flex size-5 items-center justify-center rounded-sm"
                    onClick={() => setStage("menu")}
                    aria-label="Back"
                  >
                    <ChevronLeft className="size-3.5" />
                  </button>
                  <SheetTitle>Docs and files</SheetTitle>
                </div>
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search documents…"
                  autoFocus
                />
              </SheetHeader>
              {documentsCount === 0 ? (
                <div className="text-muted-foreground p-4 text-sm">
                  No documents yet.
                </div>
              ) : items.length === 0 ? (
                <div className="text-muted-foreground p-4 text-sm">
                  No matches.
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto p-1 sm:p-2">
                  {items.map((item) => (
                    <button
                      key={`${item.refType}-${item.id}`}
                      className={cn(
                        "hover:bg-hover flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left",
                        "min-h-11",
                      )}
                      onClick={() => addItem(getReferencesForItem(item))}
                      type="button"
                    >
                      {item.refType === "folder" ? (
                        <Folder className="text-muted-foreground size-4 shrink-0" />
                      ) : (
                        <FileText className="text-muted-foreground size-4 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">{item.name}</div>
                        {item.path !== item.name && (
                          <div className="text-muted-foreground truncate text-xs">
                            {item.path}
                          </div>
                        )}
                      </div>
                      {item.refType === "folder" && (
                        <div className="text-muted-foreground shrink-0 text-xs">
                          Add all
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
