/**
 * ContextRail — the chat-screen right rail: a mini file browser with an
 * editable inline active-document surface and binary previews for non-tracked files.
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
  ChevronLeft,
  ChevronRight,
  FileText,
  Folder,
  Loader2,
  Sparkles,
  Upload,
} from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";

import type { ProjectResultItem } from "@/client/api/project-results-api";
import { useContextWorkId } from "@/client/query/useContextWorkId";
import { useDocumentFigureSignedUrl } from "@/client/query/useDocumentFigureSignedUrl";
import { useProjectContextTree } from "@/client/query/useProjectContextTree";
import { useThreadUploads } from "@/client/query/useThreadUploads";
import type { ContextTab } from "@/client/stores";
import { DocumentRailSection, Section } from "@/features/chat/ThreadDocumentList";
import { cn } from "@/lib/utils";
import { ActiveDocumentSurface } from "../context/ActiveDocumentSurface";
import {
  collapseBreadcrumbSegments,
  folderAncestry,
  parentFolder as parentFolderOf,
  pathLeafName,
} from "../context/context-location";
import { schemeIcon, schemeLabel, visibleContextSchemes } from "../context/context-schemes";
import { contextTabFromFile } from "../context/context-tab-from-file";
import {
  type ContextDir,
  type ContextFile,
  findContextDir,
  findContextFile,
} from "../context/context-tree";
import { BinaryFallbackViewer } from "../context/viewers/BinaryFallbackViewer";
import { ImageViewer } from "../context/viewers/ImageViewer";
import { PdfViewer } from "../context/viewers/PdfViewer";
import { RailHeader } from "./RailHeader";
import { ResultsRailBody, useResultsRailModel } from "./ResultsRailSection";
import { ResultViewerOverlay } from "./ResultViewerOverlay";
import { SidebarSectionLabel } from "./SidebarSectionLabel";

/** Owner key for the rail's editor mount host. Distinct from the center's key
 *  so the two can coexist (center stays mounted offscreen when on Chat) without
 *  racing each other's `DocumentSessionRegistry.retain()` calls. */
const RAIL_EDITOR_OWNER = "context-rail-active-document-surface";

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

type RailOpenDocumentBase = {
  documentId: string;
  name: string;
  mimeType: string | null;
  filetype: Filetype | null;
  schemaType: YjsTrackedSchemaType | null;
};

export type RailOpenDocument =
  | {
      kind: "context";
      scheme: ProjectContextTreeScheme;
      path: string;
    }
  | (RailOpenDocumentBase & { kind: "upload" });

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

  // Drop the viewer and jump the tree's drill position in one click. The
  // viewer-mode location breadcrumb uses this so clicking an ancestor lands
  // the writer in the tree at that level (vs. back-button-then-drill).
  const navigateToTree = useCallback(
    (next: RailDrill) => {
      setDrill(next);
      onDismissViewer();
    },
    [onDismissViewer],
  );

  return (
    <aside aria-label={t`Thread context`} className="flex h-full min-h-0 w-full flex-col">
      <ContextRailHeader
        viewing={showContextViewer || showUploadViewer}
        onBack={onDismissViewer}
        onClose={onClose}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {showUploadViewer ? (
          <>
            <UploadLocationBreadcrumb
              uploadName={railUploadTarget.name}
              onSelectUploadsRoot={() => navigateToTree({ level: "root" })}
            />
            <RailUploadViewerSlot
              projectId={projectId}
              threadId={threadId}
              target={railUploadTarget}
            />
          </>
        ) : showContextViewer ? (
          <>
            <ContextDocLocationBreadcrumb
              scheme={activeScheme}
              path={activePath}
              onSelectSchemeRoot={() => navigateToTree({ level: "scheme", scheme: activeScheme })}
              onSelectFolder={(folder) =>
                navigateToTree({ level: "folder", scheme: activeScheme, folder })
              }
            />
            <RailContextDocViewerSlot
              projectId={projectId}
              threadId={threadId}
              scheme={activeScheme}
              path={activePath}
            />
          </>
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

/**
 * Rail chrome bar. In tree mode it shows the "Context" section label; in
 * viewer mode it swaps to a "← Back to files" return affordance. The
 * document's location renders as a separate breadcrumb sub-row below the
 * header (`ContextDocLocationBreadcrumb` / `UploadLocationBreadcrumb`),
 * matching the drill-mode two-row layout.
 */
function ContextRailHeader({
  viewing,
  onBack,
  onClose,
}: {
  viewing: boolean;
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
        className="focus-ring inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-foreground transition-colors hover:bg-sidebar-accent"
      >
        <ArrowLeft className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate font-medium">
          <Trans>Back to files</Trans>
        </span>
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
    const currentFolder = drill.level === "folder" ? drill.folder : null;
    return (
      <RailFolderDrill
        projectId={projectId}
        threadId={threadId}
        scheme={drill.scheme}
        folder={currentFolder}
        onDrillFolder={(folder) => onDrill({ level: "folder", scheme: drill.scheme, folder })}
        onSelectRoot={() => onDrill({ level: "root" })}
        onSelectSchemeRoot={() => onDrill({ level: "scheme", scheme: drill.scheme })}
        onSelectFolder={(folder) => onDrill({ level: "folder", scheme: drill.scheme, folder })}
        onOpenFile={(file) => {
          const tab = contextTabFromFile(drill.scheme, file, workId);
          onOpenInRail({
            kind: "context",
            scheme: tab.scheme,
            path: tab.path,
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
          kind: "upload",
          documentId: row.documentId,
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
  onSelectRoot,
  onSelectSchemeRoot,
  onSelectFolder,
  onOpenFile,
}: {
  projectId: string;
  threadId: string | null;
  scheme: ProjectContextTreeScheme;
  /** Current folder path (`/a/b`) or null for the scheme root. */
  folder: string | null;
  onDrillFolder: (folder: string) => void;
  /** Return to the rail's scheme-picker root. */
  onSelectRoot: () => void;
  /** Jump to the scheme's root folder (clears any folder drill). */
  onSelectSchemeRoot: () => void;
  /** Jump to a specific ancestor folder (`/a/b` path). */
  onSelectFolder: (folder: string) => void;
  onOpenFile: (file: ProjectContextTreeFile) => void;
}) {
  const { tree, isError, isFetching } = useProjectContextTree(projectId, scheme, {
    activeThreadId: threadId,
  });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <DrillBreadcrumb
        scheme={scheme}
        folder={folder}
        onSelectRoot={onSelectRoot}
        onSelectSchemeRoot={onSelectSchemeRoot}
        onSelectFolder={onSelectFolder}
      />
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

/**
 * Clickable trail for the drill position: `[‹] SchemeLabel › folderA ›
 * folderB`. The leading `‹` button returns to the rail's scheme picker; the
 * scheme crumb returns to the scheme's root folder; each folder crumb jumps
 * to that ancestor; the current location (last crumb) is non-interactive.
 *
 * Deep trails collapse the middle via `collapseBreadcrumbSegments` so the
 * row stays readable inside the ~240–280px rail width.
 */
function DrillBreadcrumb({
  scheme,
  folder,
  onSelectRoot,
  onSelectSchemeRoot,
  onSelectFolder,
}: {
  scheme: ProjectContextTreeScheme;
  folder: string | null;
  onSelectRoot: () => void;
  onSelectSchemeRoot: () => void;
  onSelectFolder: (folder: string) => void;
}) {
  const ancestry = folderAncestry(folder);
  const lastAncestorIdx = ancestry.length - 1;
  const segments: RailBreadcrumbSegment[] = [
    // The scheme crumb returns to the scheme's root folder UNLESS we're
    // already there — then it's the current (non-interactive) segment.
    {
      label: schemeLabel(scheme),
      onSelect: folder === null ? undefined : onSelectSchemeRoot,
    },
    ...ancestry.map((entry, idx) => ({
      label: entry.name,
      // The deepest ancestor IS the current folder, so it doesn't navigate.
      onSelect: idx === lastAncestorIdx ? undefined : () => onSelectFolder(entry.path),
    })),
  ];

  return (
    <BreadcrumbRow>
      <BackToRootButton onClick={onSelectRoot} label={t`Back to all sections`} />
      <RailBreadcrumb segments={segments} ariaLabel={t`Current folder`} />
    </BreadcrumbRow>
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
  // Editable context docs render through the SAME ActiveDocumentSurface as
  // the center pane so the rail's editor is byte-for-byte the main editor:
  // formatting toolbar, collab cursors, Yjs sync — same component, same
  // behaviour. Non-tracked tabs route through the viewer host inside the
  // surface (image / PDF / generic binary previews).
  return (
    <ActiveDocumentSurface
      projectId={projectId}
      activeThreadId={threadId}
      trackedTabs={tab.editable ? [tab] : []}
      activeTab={tab}
      activeTabId={tab.documentId}
      registryOwner={RAIL_EDITOR_OWNER}
      editorOwner={RAIL_EDITOR_OWNER}
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
    // tracked doc) flow through the same editable surface as context docs.
    // The synthesized tab's scheme/path are placeholders the editor never
    // reads — `EditorView` dispatches on `documentId + schemaType` only —
    // so we just need them to satisfy the `ContextTab` shape.
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
      <ActiveDocumentSurface
        projectId={projectId}
        activeThreadId={threadId}
        trackedTabs={[tab]}
        activeTab={tab}
        activeTabId={tab.documentId}
        registryOwner={RAIL_EDITOR_OWNER}
        editorOwner={RAIL_EDITOR_OWNER}
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

/* ── Viewer-mode location breadcrumbs ────────────────────────────────── */

/**
 * Location breadcrumb for the open context document — `SchemeLabel ›
 * folderA › chapter-7.md`. Ancestor crumbs drop the viewer and land the
 * rail's tree at that level so the writer can keep navigating without an
 * extra back-tap.
 */
function ContextDocLocationBreadcrumb({
  scheme,
  path,
  onSelectSchemeRoot,
  onSelectFolder,
}: {
  scheme: ProjectContextTreeScheme;
  path: string;
  onSelectSchemeRoot: () => void;
  onSelectFolder: (folder: string) => void;
}) {
  // The route's path is the file (e.g. `/a/b/chapter-7.md`). The folder
  // ancestry is `dirname(path)` walked from the scheme root inward.
  const parentDir = parentFolderOf(path);
  const ancestry = folderAncestry(parentDir);
  const leaf = pathLeafName(path);
  const segments: RailBreadcrumbSegment[] = [
    { label: schemeLabel(scheme), onSelect: onSelectSchemeRoot },
    ...ancestry.map((entry) => ({
      label: entry.name,
      onSelect: () => onSelectFolder(entry.path),
    })),
    // File itself is the current location — non-interactive.
    { label: leaf },
  ];
  return (
    <BreadcrumbRow>
      <RailBreadcrumb segments={segments} ariaLabel={t`Document location`} />
    </BreadcrumbRow>
  );
}

/**
 * Uploads are flat (no folder structure), so the trail is always
 * `Uploads › <filename>`. Clicking `Uploads` returns to the rail's scheme
 * picker, where the uploads section is rendered.
 */
function UploadLocationBreadcrumb({
  uploadName,
  onSelectUploadsRoot,
}: {
  uploadName: string;
  onSelectUploadsRoot: () => void;
}) {
  const segments: RailBreadcrumbSegment[] = [
    { label: schemeLabel("uploads"), onSelect: onSelectUploadsRoot },
    { label: uploadName },
  ];
  return (
    <BreadcrumbRow>
      <RailBreadcrumb segments={segments} ariaLabel={t`Upload location`} />
    </BreadcrumbRow>
  );
}

/* ── Breadcrumb primitives ───────────────────────────────────────────── */

type RailBreadcrumbSegment = {
  label: string;
  /** Omit on the current (last) segment to mark it non-interactive. */
  onSelect?: () => void;
};

/**
 * Compact horizontal breadcrumb tuned for the chat-screen rail width
 * (~240–280px). Trails of more than four segments middle-truncate via
 * `collapseBreadcrumbSegments`; per-segment labels truncate within a small
 * max-width so the current location keeps the leftover room.
 */
function RailBreadcrumb({
  segments,
  ariaLabel,
}: {
  segments: RailBreadcrumbSegment[];
  ariaLabel: string;
}) {
  if (segments.length === 0) return null;
  const { leading, elided, trailing } = collapseBreadcrumbSegments(segments);
  type Item =
    | { kind: "segment"; key: string; segment: RailBreadcrumbSegment }
    | { kind: "ellipsis"; key: string };
  const items: Item[] = leading.map((segment, position) => ({
    kind: "segment",
    key: `segment-${position}`,
    segment,
  }));
  if (elided) items.push({ kind: "ellipsis", key: "ellipsis" });
  const trailingStart = segments.length - trailing.length;
  trailing.forEach((segment, offset) => {
    items.push({ kind: "segment", key: `segment-${trailingStart + offset}`, segment });
  });
  const lastIndex = items.length - 1;
  return (
    <nav aria-label={ariaLabel} className="flex min-w-0 flex-1 items-center">
      <ol className="flex min-w-0 items-center">
        {items.map((item, index) => {
          const separator =
            index > 0 ? (
              <ChevronRight aria-hidden className="size-3 shrink-0 text-ink-subtle" />
            ) : null;
          if (item.kind === "ellipsis") {
            return (
              <li
                aria-hidden
                key={item.key}
                className="flex shrink-0 items-center text-sm text-muted-foreground"
              >
                {separator}
                <span className="px-0.5">…</span>
              </li>
            );
          }
          if (index === lastIndex || !item.segment.onSelect) {
            return (
              <li
                aria-current={index === lastIndex ? "page" : undefined}
                key={item.key}
                className="flex min-w-0 items-center"
              >
                {separator}
                <span
                  className={cn(
                    "block truncate px-1 text-sm",
                    index === lastIndex ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {item.segment.label}
                </span>
              </li>
            );
          }
          return (
            <li key={item.key} className="flex min-w-0 max-w-28 shrink items-center">
              {separator}
              <button
                type="button"
                onClick={item.segment.onSelect}
                className="focus-ring inline-flex min-w-0 cursor-pointer items-center rounded-md px-1 py-0.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
              >
                <span className="truncate">{item.segment.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * Two-row layout chrome: a thin border-b strip below the rail header that
 * houses the breadcrumb (drill or location). Matches the height of the old
 * DrillBreadcrumb so the rail's overall geometry doesn't shift between
 * modes.
 */
function BreadcrumbRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border-subtle px-2">
      {children}
    </div>
  );
}

/**
 * Compact icon-only return affordance ("‹") rendered before the drill
 * breadcrumb. Distinct from the viewer header's full "← Back to files" so
 * the breadcrumb row stays narrow and the trail starts immediately.
 */
function BackToRootButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="focus-ring inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
    >
      <ChevronLeft className="size-4" aria-hidden />
    </button>
  );
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
