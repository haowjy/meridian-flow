// @ts-nocheck
/**
 * Proto shell demonstrating lifted persistent surfaces — session registry above
 * destination switch, Motion layout chat, reverse-portal document reparenting.
 */
import { useEffect, useState } from "react";
import { createHtmlPortalNode, InPortal, OutPortal } from "react-reverse-portal";

import { cn } from "@/lib/utils";

import { PersistentChatSurface } from "./PersistentChatSurface";
import { PersistentDocContent } from "./PersistentDocContent";
import {
  DocSlot,
  FilesPlaceholder,
  SidebarPlaceholder,
  TablePlaceholder,
  UploadsRailPlaceholder,
} from "./placeholders";
import { SessionRegistryProvider } from "./session-registry";
import type { Destination } from "./types";
import { useShellState } from "./use-shell-state";

const DESTINATIONS: { id: Destination; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "chat", label: "Chat" },
  { id: "context", label: "Context" },
];

export function PersistentSurfacesShell() {
  // react-reverse-portal's createHtmlPortalNode touches `document`, so it must be
  // created client-only — SSR has no `document`. Create it after mount and only
  // wire the portal once it exists (avoids the hydration mismatch).
  const [docPortalNode, setDocPortalNode] = useState<ReturnType<
    typeof createHtmlPortalNode
  > | null>(null);
  useEffect(() => {
    setDocPortalNode(createHtmlPortalNode());
  }, []);

  return (
    <SessionRegistryProvider>
      {docPortalNode ? (
        <InPortal node={docPortalNode}>
          <PersistentDocContent />
        </InPortal>
      ) : null}

      <ShellLayout docPortalNode={docPortalNode} />
    </SessionRegistryProvider>
  );
}

function ShellLayout({
  docPortalNode,
}: {
  docPortalNode: ReturnType<typeof createHtmlPortalNode> | null;
}) {
  const destination = useShellState((s) => s.destination);
  const docPeekOpen = useShellState((s) => s.docPeekOpen);
  const setDestination = useShellState((s) => s.setDestination);
  const toggleDocPeek = useShellState((s) => s.toggleDocPeek);

  const chatPlacement = destination === "chat" ? "center" : "dock";

  return (
    <div className="app-frame flex min-h-0 flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <span className="mr-2 text-meta uppercase tracking-wide text-muted-foreground">
          Persistent surfaces proto
        </span>
        <div className="flex gap-1">
          {DESTINATIONS.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setDestination(d.id)}
              className={cn(
                "focus-ring rounded-lg px-3 py-1.5 text-body font-medium transition-colors",
                destination === d.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              data-testid={`dest-${d.id}`}
            >
              {d.label}
            </button>
          ))}
        </div>
        {destination === "chat" ? (
          <button
            type="button"
            onClick={toggleDocPeek}
            className={cn(
              "focus-ring ml-auto rounded-lg border px-3 py-1.5 text-body transition-colors",
              docPeekOpen
                ? "border-primary bg-chip-primary-bg text-foreground"
                : "border-border text-muted-foreground hover:border-border-focus",
            )}
            data-testid="toggle-doc-peek"
          >
            {docPeekOpen ? "Close doc peek" : "Open doc from chat"}
          </button>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1">
        <SidebarPlaceholder />

        <div
          className={cn(
            "relative flex min-h-0 min-w-0 flex-1",
            chatPlacement === "dock" && "pr-72",
          )}
        >
          {destination === "home" ? <TablePlaceholder /> : null}

          {destination === "chat" ? (
            <div className="flex min-h-0 min-w-0 flex-1">
              {docPeekOpen ? (
                <DocSlot label="chat side-peek">
                  {docPortalNode ? <OutPortal node={docPortalNode} /> : null}
                </DocSlot>
              ) : (
                <div className="flex min-h-0 flex-1 items-center justify-center p-6">
                  <p className="max-w-sm text-center text-body text-muted-foreground">
                    Center is the lifted chat. Use &ldquo;Open doc from chat&rdquo; to mount the
                    same document node in a side peek.
                  </p>
                </div>
              )}
            </div>
          ) : null}

          {destination === "context" ? (
            <div className="flex min-h-0 min-w-0 flex-1">
              <FilesPlaceholder />
              <DocSlot label="context main">
                {docPortalNode ? <OutPortal node={docPortalNode} /> : null}
              </DocSlot>
            </div>
          ) : null}

          <PersistentChatSurface
            placement={chatPlacement}
            docPeekOpen={destination === "chat" && docPeekOpen}
          />
        </div>

        {destination === "chat" ? <UploadsRailPlaceholder /> : null}
      </div>
    </div>
  );
}
