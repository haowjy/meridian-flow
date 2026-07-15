/**
 * Cheap remountable placeholders — labeled so it's obvious they are NOT lifted.
 */
import type { ReactNode } from "react";

export function SidebarPlaceholder() {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="border-b border-border-subtle px-3 py-2 text-meta uppercase tracking-wide text-muted-foreground">
        Sidebar (static)
      </div>
      <nav className="flex flex-col gap-1 p-2">
        {["Recents", "Projects", "Packages"].map((item) => (
          <div key={item} className="rounded-lg px-2 py-1.5 text-body text-ink-muted">
            {item}
          </div>
        ))}
      </nav>
    </aside>
  );
}

export function TablePlaceholder() {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-4" data-testid="home-main-placeholder">
      <span className="mb-2 text-meta uppercase tracking-wide text-destructive">
        Remounts freely — table placeholder
      </span>
      <div className="grid flex-1 place-content-center rounded-xl border border-dashed border-border bg-muted/40">
        <p className="text-body text-muted-foreground">Home table / works grid</p>
      </div>
    </div>
  );
}

export function UploadsRailPlaceholder() {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-l border-border bg-sidebar">
      <div className="border-b border-border-subtle px-3 py-2 text-meta uppercase tracking-wide text-destructive">
        Remounts — uploads rail
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        {["Upload A", "Upload B", "Recent file"].map((item) => (
          <div key={item} className="rounded-lg bg-muted px-2 py-2 text-body text-ink-muted">
            {item}
          </div>
        ))}
      </div>
    </aside>
  );
}

export function FilesPlaceholder() {
  return (
    <div className="flex w-48 shrink-0 flex-col border-r border-border-subtle bg-muted">
      <div className="border-b border-border-subtle px-3 py-2 text-meta uppercase tracking-wide text-destructive">
        Remounts — files
      </div>
      <ul className="flex flex-col gap-1 p-2">
        {["notes.md", "protocol.pdf", "data.csv"].map((f) => (
          <li key={f} className="rounded-md px-2 py-1 text-body text-ink-muted">
            {f}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DocSlot({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col p-3"
      data-testid={`doc-slot-${label.replace(/\s+/g, "-")}`}
    >
      <span className="mb-2 text-meta uppercase tracking-wide text-muted-foreground">
        OutPortal slot — {label}
      </span>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
