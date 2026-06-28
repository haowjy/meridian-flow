/**
 * Interactive proto shell for sticky thread-contents popover — single demo, mode toggle.
 * Disposable — inline fixtures only; scrolls on mobile via h-svh overflow-y-auto.
 */
import { useState } from "react";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

import { ThreadInfoDemo, type ViewerMode } from "./ThreadInfoDemo";

export function ThreadInfoProtoShell() {
  const [mode, setMode] = useState<ViewerMode>("chat");

  return (
    <div className="h-svh w-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6 sm:px-6 sm:py-8">
        <header className="flex flex-col gap-2">
          <span className="text-meta uppercase tracking-[0.14em] text-muted-foreground">
            Proto / thread info
          </span>
          <h1 className="text-balance text-xl font-semibold tracking-tight sm:text-2xl">
            Sticky thread contents popover
          </h1>
          <p className="max-w-[60ch] text-sm leading-relaxed text-ink-muted">
            Open ⓘ, pick a document, then type in the composer without the popover closing. Toggle
            mode to see where the active doc surfaces.
          </p>
        </header>

        <div className="flex flex-col gap-2">
          <ToggleGroup
            type="single"
            value={mode}
            onValueChange={(value) => {
              if (value === "chat" || value === "context-viewer") setMode(value);
            }}
            className="inline-flex w-fit rounded-md border border-border-subtle bg-surface-subtle p-0.5"
          >
            <ModeToggleItem value="chat">Chat mode</ModeToggleItem>
            <ModeToggleItem value="context-viewer">Context-viewer mode</ModeToggleItem>
          </ToggleGroup>
          <p className="text-meta text-muted-foreground">
            {mode === "chat"
              ? "Active doc opens in the left sidebar."
              : "Active doc opens in the main context viewer on the left."}
          </p>
        </div>

        <div className="overflow-hidden rounded-lg border border-border-subtle bg-card shadow-sm">
          <ThreadInfoDemo mode={mode} />
        </div>
      </div>
    </div>
  );
}

function ModeToggleItem({ value, children }: { value: ViewerMode; children: string }) {
  return (
    <ToggleGroupItem
      value={value}
      className={cn(
        "cursor-pointer rounded px-3 py-1.5 text-xs font-medium text-muted-foreground",
        "data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm",
      )}
    >
      {children}
    </ToggleGroupItem>
  );
}
