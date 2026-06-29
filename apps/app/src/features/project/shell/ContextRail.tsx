/**
 * ContextRail — the chat-screen right rail: a mini file browser with an
 * inline read-only document viewer.
 *
 * Tree mode lets the writer drill into project context (Manuscript / KB /
 * User / Work, plus a virtual Uploads section sourced from this thread's
 * uploads) and a Results section. Clicking a file swaps the rail to viewer
 * mode without leaving Chat. The popover at both chat sites opens documents
 * through the same parent-owned `handleOpenInRail`, so popover-click and
 * tree-click share one path.
 *
 * Viewer mode is DERIVED (decision #1 in the architecture doc): context-doc
 * viewing reads scheme/path from the URL gated by `railViewerDismissed`;
 * upload viewing reads `railUploadTarget`. Storing rail-view identity in
 * both URL and local state would create two sources of truth — so the rail
 * owns only the tree drill position, and the parent owns the upload target
 * and dismissed flag.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type {
  Filetype,
  ProjectContextTreeFile,
  ProjectContextTreeScheme,
  YjsTrackedSchemaType,
} from "@meridian/contracts/protocol";
import {
  AlertCircle,
  ArrowLeft,
  ChevronRight,
  FileText,
  Folder,
  Loader2,
  Sparkles,
  Upload,
} from "lucide-react";
import { useState } from "react";

import type { ProjectResultItem } from "@/client/api/project-results-api";
import { useContextWorkId } from "@/client/query/useContextWorkId";
import { useDocumentFigureSignedUrl } from "@/client/query/useDocumentFigureSignedUrl";
import { useProjectContextTree } from "@/client/query/useProjectContextTree";
import { useThreadUploads } from "@/client/query/useThreadUploads";
import type { ContextTab } from "@/client/stores";
import { DocumentRailSection, Section } from "@/features/chat/ThreadDocumentList";
import { cn } from "@/lib/utils";
import { schemeIcon, schemeLabel, visibleContextSchemes } from "../context/context-schemes";
import { contextTabFromFile } from "../context/context-tab-from-file";
import {
  type ContextDir,
  type ContextFile,
  findContextDir,
  findContextFile,
} from "../context/context-tree";
import { ReadOnlyDocHost } from "../context/ReadOnlyDocHost";
import { BinaryFallbackViewer } from "../context/viewers/BinaryFallbackViewer";
import { ImageViewer } from "../context/viewers/ImageViewer";
import { PdfViewer } from "../context/viewers/PdfViewer";
import { RailHeader } from "./RailHeader";
import { ResultsRailBody, useResultsRailModel } from "./ResultsRailSection";
import { ResultViewerOverlay } from "./ResultViewerOverlay";
import { SidebarSectionLabel } from "./SidebarSectionLabel";

const RAIL_REGISTRY_OWNER = "context-rail-document-host";

/**
 * Identity of the thread upload currently shown in the rail viewer. The full
 * row metadata travels with the target so the viewer can dispatch
 * tracked-vs-binary without re-querying.
 */
export type RailUploadTarget = {
  documentId: string;
  name: string;
  mimeType: string | null;
  filetype: Filetype | null;
  schemaType: YjsTrackedSchemaType | null;
};

export type RailOpenDocument = {
  documentId: string;
  scheme: ProjectContextTreeScheme | null;
  path: string | null;
  name: string;
  mimeType: string | null;
  filetype: Filetype | null;
  schemaType: YjsTrackedSchemaType | null;
};

export type ContextRailProps = {
  projectId: string;
  threadId: string | null;
  /** Active context document scheme, mirrored from the URL. */
  activeScheme: ProjectContextTreeScheme | null;
  /** Active context document path, mirrored from the URL. */
  activePath: string | null;
  /** Upload currently shown in the rail viewer (null = no upload viewer). */
  railUploadTarget: RailUploadTarget | null;
  /** When true the writer has explicitly returned to the tree from a context-doc viewer. */
  railViewerDismissed: boolean;
  /** Open a context doc or upload in the rail viewer through the parent-owned path. */
  onOpenInRail: (doc: RailOpenDocument) => void;
  /** ← Back: drop both viewer modes and return to the tree. */
  onDismissViewer: () => void;
  /** Collapse the rail (header chrome). */
  onClose: () => void;
};

/** Local tree drill position. Viewer modes are derived from parent props. */
type RailDrill =
  | { level: "root" }
  | { level: "scheme"; scheme: ProjectContextTreeScheme }
  | { level: "folder"; scheme: ProjectContextTreeScheme; folder: string };

export function ContextRail({
  projectId,
  threadId,
  activeScheme,
  activePath,
  railUploadTarget,
  railViewerDismissed,
  onOpenInRail,
  onDismissViewer,
  onClose,
}: ContextRailProps) {
  const [drill, setDrill] = useState<RailDrill>({ level: "root" });

  // Viewer mode is DERIVED: context doc lives in the URL (scheme/path)
  // gated by an explicit dismiss; uploads have no URL representation so
  // they need their own target.
  const showUploadViewer = railUploadTarget !== null;
  const showContextViewer =
    !showUploadViewer && activeScheme !== null && activePath !== null && !railViewerDismissed;
  // Tree mode is implicit: rendered when neither viewer derivation fires.
  // `showTree` would be the third disjoint flag — read it off the others.

  return (
    <aside aria-label={t`Thread context`} className="flex h-full min-h-0 w-full flex-col">
      <ContextRailHeader
        viewing={showContextViewer || showUploadViewer}
        title={
          showUploadViewer
            ? railUploadTarget.name
            : showContextViewer
              ? (activePath?.split("/").filter(Boolean).pop() ?? "")
              : null
        }
        onBack={onDismissViewer}
        onClose={onClose}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {showUploadViewer ? (
          <RailUploadViewerSlot
            projectId={projectId}
            threadId={threadId}
            target={railUploadTarget}
          />
        ) : showContextViewer ? (
          <RailContextDocViewerSlot
            projectId={projectId}
            threadId={threadId}
            scheme={activeScheme}
            path={activePath}
          />
        ) : (
          <RailTreeBody
            projectId={projectId}
            threadId={threadId}
            drill={drill}
            onDrill={setDrill}
            onOpenInRail={onOpenInRail}
          />
        )}
      </div>
    </aside>
  );
}

/* ── Header ──────────────────────────────────────────────────────────── */

function ContextRailHeader({
  viewing,
  title,
  onBack,
  onClose,
}: {
  viewing: boolean;
  title: string | null;
  onBack: () => void;
  onClose: () => void;
}) {
  if (!viewing) {
    return (
      <RailHeader onClose={onClose} closeLabel={t`Collapse context  ]`} side="right">
        <SidebarSectionLabel>
          <Trans>Context</Trans>
        </SidebarSectionLabel>
      </RailHeader>
    );
  }
  return (
    <RailHeader onClose={onClose} closeLabel={t`Collapse context  ]`} side="right">
      <button
        type="button"
        onClick={onBack}
        aria-label={t`Back to files`}
        title={t`Back to files`}
        className="focus-ring inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-foreground transition-colors hover:bg-sidebar-accent"
      >
        <ArrowLeft className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate font-medium">{title ?? ""}</span>
      </button>
    </RailHeader>
  );
}

/* ── Tree body ───────────────────────────────────────────────────────── */

function RailTreeBody({
  projectId,
  threadId,
  drill,
  onDrill,
  onOpenInRail,
}: {
  projectId: string;
  threadId: string | null;
  drill: RailDrill;
  onDrill: (next: RailDrill) => void;
  onOpenInRail: (doc: RailOpenDocument) => void;
}) {
  const workId = useContextWorkId(projectId, threadId);
  const schemes = visibleContextSchemes(workId, "rail");

  if (drill.level === "scheme" || drill.level === "folder") {
    return (
      <RailFolderDrill
        projectId={projectId}
        threadId={threadId}
        scheme={drill.scheme}
        folder={drill.level === "folder" ? drill.folder : null}
        onDrillFolder={(folder) => onDrill({ level: "folder", scheme: drill.scheme, folder })}
        onBackUp={() => {
          if (drill.level === "folder") {
            // Up one folder; if we were at the immediate scheme root, drop
            // back to the scheme listing.
            const parent = parentFolder(drill.folder);
            if (parent === null) {
              onDrill({ level: "scheme", scheme: drill.scheme });
              return;
            }
            onDrill({ level: "folder", scheme: drill.scheme, folder: parent });
            return;
          }
          onDrill({ level: "root" });
        }}
        onOpenFile={(file) => {
          const tab = contextTabFromFile(drill.scheme, file, workId);
          onOpenInRail({
            documentId: tab.documentId,
            scheme: tab.scheme,
            path: tab.path,
            name: tab.name,
            mimeType: null,
            filetype: null,
            schemaType: null,
          });
        }}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden px-2 py-2">
      <SchemeList schemes={schemes} onDrill={(scheme) => onDrill({ level: "scheme", scheme })} />
      <RailUploadsSection threadId={threadId} onOpenInRail={onOpenInRail} />
      <RailResultsSection projectId={projectId} />
    </div>
  );
}

function SchemeList({
  schemes,
  onDrill,
}: {
  schemes: readonly ProjectContextTreeScheme[];
  onDrill: (scheme: ProjectContextTreeScheme) => void;
}) {
  return (
    <ul className="flex flex-col">
      {schemes.map((scheme) => {
        const Icon = schemeIcon(scheme);
        return (
          <li key={scheme}>
            <DrillRow
              icon={<Icon aria-hidden className="size-4 shrink-0 text-primary/80" />}
              label={schemeLabel(scheme)}
              drillsIn
              onClick={() => onDrill(scheme)}
            />
          </li>
        );
      })}
    </ul>
  );
}

function RailUploadsSection({
  threadId,
  onOpenInRail,
}: {
  threadId: string | null;
  onOpenInRail: (doc: RailOpenDocument) => void;
}) {
  const uploads = useThreadUploads(threadId);
  // The DocumentRailSection primitive owns the disabled/loading/empty/
  // ready/error state machine; we just wrap its select callback to lift
  // the full upload row (not just the id) into the rail upload target.
  return (
    <DocumentRailSection
      title={t`Uploads`}
      icon={<Upload className="size-3.5" />}
      defaultOpen
      status={uploads}
      rows={uploads.uploads}
      messages={{
        disabled: t`Open a chat to see its uploads.`,
        loading: t`Loading uploads…`,
        empty: t`No files uploaded yet.`,
        error: t`Couldn't load uploads.`,
      }}
      onSelectDocument={(documentId) => {
        const row = uploads.uploads?.find((u) => u.documentId === documentId);
        if (!row) return;
        onOpenInRail({
          documentId: row.documentId,
          scheme: null,
          path: null,
          name: row.name,
          mimeType: row.mimeType,
          filetype: row.filetype,
          schemaType: row.schemaType,
        });
      }}
    />
  );
}

function RailResultsSection({ projectId }: { projectId: string }) {
  // Results are project-scoped (not thread-scoped) and AI-generated — they
  // stay in the rail because they aren't surfaced anywhere else in the
  // popover/tree. Behavior matches the old ContextSidebar: opens via the
  // shared ResultViewerOverlay.
  const [openResult, setOpenResult] = useState<ProjectResultItem | null>(null);
  const results = useResultsRailModel(projectId);

  return (
    <>
      <Section
        title={t`Results`}
        icon={<Sparkles className="size-3.5" />}
        count={results.count}
        defaultOpen
      >
        <ResultsRailBody projectId={projectId} model={results} onOpenResult={setOpenResult} />
      </Section>
      {openResult ? (
        <ResultViewerOverlay
          projectId={projectId}
          result={openResult}
          onClose={() => setOpenResult(null)}
        />
      ) : null}
    </>
  );
}

/* ── Drill (scheme / folder) ─────────────────────────────────────────── */

function RailFolderDrill({
  projectId,
  threadId,
  scheme,
  folder,
  onDrillFolder,
  onBackUp,
  onOpenFile,
}: {
  projectId: string;
  threadId: string | null;
  scheme: ProjectContextTreeScheme;
  /** Current folder path (`/a/b`) or null for the scheme root. */
  folder: string | null;
  onDrillFolder: (folder: string) => void;
  onBackUp: () => void;
  onOpenFile: (file: ProjectContextTreeFile) => void;
}) {
  const { tree, isError, isFetching } = useProjectContextTree(projectId, scheme, {
    activeThreadId: threadId,
  });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <DrillBreadcrumb scheme={scheme} folder={folder} onBackUp={onBackUp} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DrillListingBody
          tree={tree}
          isError={isError}
          isFetching={isFetching}
          folder={folder}
          onDrillFolder={onDrillFolder}
          onOpenFile={onOpenFile}
        />
      </div>
    </div>
  );
}

function DrillBreadcrumb({
  scheme,
  folder,
  onBackUp,
}: {
  scheme: ProjectContextTreeScheme;
  folder: string | null;
  onBackUp: () => void;
}) {
  const tail = folder ? folder.split("/").filter(Boolean).pop() : null;
  const label = tail ?? schemeLabel(scheme);
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border-subtle px-2">
      <button
        type="button"
        onClick={onBackUp}
        aria-label={t`Up one level`}
        title={t`Up one level`}
        className="focus-ring inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-sm text-foreground transition-colors hover:bg-sidebar-accent"
      >
        <ArrowLeft className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate font-medium">{label}</span>
      </button>
    </div>
  );
}

function DrillListingBody({
  tree,
  isError,
  isFetching,
  folder,
  onDrillFolder,
  onOpenFile,
}: {
  tree: ContextDir | null;
  isError: boolean;
  isFetching: boolean;
  folder: string | null;
  onDrillFolder: (folder: string) => void;
  onOpenFile: (file: ProjectContextTreeFile) => void;
}) {
  if (isError) {
    return (
      <RailStatus tone="error">
        <AlertCircle className="size-4" aria-hidden />
        <Trans>Could not load files.</Trans>
      </RailStatus>
    );
  }
  if (!tree) {
    return (
      <RailStatus tone="muted">
        {isFetching ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden />
            <Trans>Loading files…</Trans>
          </>
        ) : (
          <Trans>No context files yet.</Trans>
        )}
      </RailStatus>
    );
  }
  const dir = findContextDir(tree, folder ?? "");
  if (!dir) {
    return (
      <RailStatus tone="muted">
        <Trans>This folder no longer exists.</Trans>
      </RailStatus>
    );
  }
  const folders = dir.children.filter((c): c is ContextDir => c.kind === "dir");
  const files = dir.children.filter((c): c is ContextFile => c.kind === "file");
  if (folders.length === 0 && files.length === 0) {
    return (
      <RailStatus tone="muted">
        <Trans>This folder is empty.</Trans>
      </RailStatus>
    );
  }
  return (
    <ul className="flex flex-col">
      {folders.map((child) => (
        <li key={child.path}>
          <DrillRow
            icon={<Folder aria-hidden className="size-4 shrink-0 text-primary/80" />}
            label={child.name}
            drillsIn
            onClick={() => onDrillFolder(child.path)}
          />
        </li>
      ))}
      {files.map((child) => (
        <li key={child.path}>
          <DrillRow
            icon={<FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
            label={child.name}
            onClick={() => onOpenFile(child)}
          />
        </li>
      ))}
    </ul>
  );
}

/* ── Viewer slots ───────────────────────────────────────────────────── */

function RailContextDocViewerSlot({
  projectId,
  threadId,
  scheme,
  path,
}: {
  projectId: string;
  threadId: string | null;
  scheme: ProjectContextTreeScheme;
  path: string;
}) {
  const workId = useContextWorkId(projectId, threadId);
  const { tree, isError, isFetching } = useProjectContextTree(projectId, scheme, {
    activeThreadId: threadId,
  });
  if (!tree) {
    if (isError) {
      return (
        <RailStatus tone="error">
          <AlertCircle className="size-4" aria-hidden />
          <Trans>Couldn't open this document.</Trans>
        </RailStatus>
      );
    }
    if (isFetching) {
      return (
        <RailStatus tone="muted">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          <Trans>Opening document…</Trans>
        </RailStatus>
      );
    }
    return null;
  }
  const file = findContextFile(tree, path);
  if (!file) {
    return (
      <RailStatus tone="muted">
        <Trans>This document no longer exists.</Trans>
      </RailStatus>
    );
  }
  const tab = contextTabFromFile(scheme, file, workId);
  return (
    <ReadOnlyDocHost
      projectId={projectId}
      activeThreadId={threadId}
      tab={tab}
      registryOwner={RAIL_REGISTRY_OWNER}
    />
  );
}

function RailUploadViewerSlot({
  projectId,
  threadId,
  target,
}: {
  projectId: string;
  threadId: string | null;
  target: RailUploadTarget;
}) {
  if (target.schemaType && target.filetype) {
    // Tracked uploads (rare but valid — e.g. a dropped `.md` becomes a
    // tracked doc) flow through the shared read-only editor host. The
    // synthesized tab carries the metadata `ReadOnlyDocHost` needs for the
    // editable branch; scheme/path are placeholders the editable branch
    // never reads (it dispatches on documentId + schemaType only).
    const tab: ContextTab = {
      documentId: target.documentId,
      scheme: "uploads",
      path: `/${target.name}`,
      name: target.name,
      editable: true,
      filetype: target.filetype,
      schemaType: target.schemaType,
    };
    return (
      <ReadOnlyDocHost
        projectId={projectId}
        activeThreadId={threadId}
        tab={tab}
        registryOwner={RAIL_REGISTRY_OWNER}
      />
    );
  }
  return <RailBinaryUploadViewer projectId={projectId} target={target} />;
}

function RailBinaryUploadViewer({
  projectId,
  target,
}: {
  projectId: string;
  target: RailUploadTarget;
}) {
  const signed = useDocumentFigureSignedUrl(projectId, target.documentId);
  if (signed.status === "loading") {
    return (
      <RailStatus tone="muted">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        <Trans>Loading file…</Trans>
      </RailStatus>
    );
  }
  if (signed.status === "error") {
    return (
      <RailStatus tone="error">
        <AlertCircle className="size-4" aria-hidden />
        <Trans>Couldn't load this file.</Trans>
      </RailStatus>
    );
  }
  if (signed.status === "disabled") return null;
  const url = signed.data.signedUrl;
  const mime = target.mimeType ?? signed.data.mimeType ?? "";
  if (mime.startsWith("image/")) {
    // fitToWidth so dock-narrow previews don't horizontal-scroll.
    return <ImageViewer url={url} name={target.name} fitToWidth />;
  }
  if (mime === "application/pdf") {
    return <PdfViewer url={url} name={target.name} />;
  }
  return <BinaryFallbackViewer url={url} mimeType={mime} name={target.name} />;
}

/* ── Primitives (rail-flavour DrillRow + status) ─────────────────────── */

function DrillRow({
  icon,
  label,
  drillsIn = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  drillsIn?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "focus-ring flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-sidebar-accent",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {drillsIn ? <ChevronRight aria-hidden className="size-4 shrink-0 text-ink-subtle" /> : null}
    </button>
  );
}

function RailStatus({ children, tone }: { children: React.ReactNode; tone: "muted" | "error" }) {
  return (
    <div
      className={cn(
        "grid h-full place-items-center px-6 text-center text-sm",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

function parentFolder(path: string): string | null {
  // "/a/b" -> "/a"; "/a" -> null (back to scheme root).
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  if (segments.length === 0) return null;
  return `/${segments.join("/")}`;
}
