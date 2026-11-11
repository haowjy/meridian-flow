/**
 * DocumentProperties — a document's imported frontmatter, shown read-only under
 * its path: one quiet line that opens to the keys and values. It is the same
 * row in main and the side, and only mounts when the catalog says the
 * document has properties; the properties themselves load by document id.
 * Nothing here edits them.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { DocumentProperties as DocumentPropertiesDto } from "@meridian/contracts";
import { ChevronRight } from "lucide-react";
import { useId } from "react";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import { useDocumentProperties } from "@/client/query/useDocumentProperties";
import { documentContextOwner, type OpenDocument } from "@/client/stores";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { editorColumnChrome } from "@/features/editor/editor-column";
import { useProjectSurfacePrefsStore } from "@/features/project/layout/surface-prefs-store";
import { cn } from "@/lib/utils";
import { DocumentPropertyValue, YamlBlock } from "./DocumentPropertyValue";

/** The catalog's word on whether a document has properties; false until it has said so. */
function useHasProperties(projectId: string, tab: OpenDocument): boolean {
  const owner = tab.kind === "new" ? {} : documentContextOwner(tab);
  const { catalog } = useContextCatalogView(
    projectId,
    tab.kind === "new" ? "unfiled" : tab.scheme,
    {
      ...owner,
      enabled: tab.kind !== "new",
    },
  );
  return tab.kind !== "new" && catalog?.findDocument(tab.documentId)?.hasProperties === true;
}

export function DocumentProperties({
  projectId,
  document,
}: {
  projectId: string;
  document: OpenDocument;
}) {
  const hasProperties = useHasProperties(projectId, document);
  if (!hasProperties) return null;
  return (
    <PropertiesRow
      key={document.documentId}
      projectId={projectId}
      documentId={document.documentId}
    />
  );
}

function PropertiesRow({ projectId, documentId }: { projectId: string; documentId: string }) {
  const regionId = useId();
  const open = useProjectSurfacePrefsStore((state) => state.documentPrefs.propertiesOpen);
  const setOpen = useProjectSurfacePrefsStore((state) => state.setPropertiesOpen);
  const query = useDocumentProperties(projectId, documentId);
  const properties = query.data;

  // Frontmatter with no keys has nothing to show or open.
  if (properties && !properties.unreadable && properties.entries.length === 0) return null;

  // The container measures this pane, so the side's narrow width reaches the geometry below.
  return (
    <div className="@container shrink-0 border-b border-border-subtle">
      <div className={editorColumnChrome}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => setOpen(!open)}
          onKeyDown={(event) => {
            // Left closes and Right opens, as a rail pane header does.
            if (event.key === "ArrowLeft") setOpen(false);
            if (event.key === "ArrowRight") setOpen(true);
          }}
          className="focus-ring -ml-1 flex h-7 w-full min-w-0 items-center rounded-md pr-1 pl-1 text-left"
        >
          <span className="flex h-7 w-4 shrink-0 items-center justify-center text-muted-foreground">
            <ChevronRight
              aria-hidden
              className={cn("size-3 transition-transform", open && "rotate-90")}
            />
          </span>
          <span className="shrink-0 font-medium text-caption text-muted-foreground">
            <Trans>Properties</Trans>
          </span>
          {open ? null : <CollapsedSummary properties={properties} failed={query.isError} />}
        </button>
      </div>
      <section id={regionId} aria-label={t`Properties`} hidden={!open}>
        {open ? (
          <div className={editorColumnChrome}>
            <div
              // Scrollable regions take the keyboard so a long block can be read without a mouse.
              // slop-lint: allow suppression a capped block must be keyboard-scrollable, and the rule can't see that
              // biome-ignore lint/a11y/noNoninteractiveTabindex: the keyboard scrolls a capped block
              tabIndex={0}
              className="focus-ring max-h-60 overflow-y-auto rounded-md pb-3 pl-4"
            >
              <PropertiesBody
                properties={properties}
                failed={query.isError}
                onRetry={() => void query.refetch()}
              />
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

/** What the closed line says after the label: the keys, or why there are none. */
function CollapsedSummary({
  properties,
  failed,
}: {
  properties: DocumentPropertiesDto | undefined;
  failed: boolean;
}) {
  if (failed) {
    return (
      <span className="ml-3 min-w-0 truncate text-caption text-destructive">
        <Trans>Couldn't load</Trans>
      </span>
    );
  }
  if (!properties) return null;
  if (properties.unreadable) {
    return (
      <span className="ml-3 min-w-0 truncate text-caption text-muted-foreground">
        {properties.truncated ? <Trans>Too large to show</Trans> : <Trans>Couldn't be read</Trans>}
      </span>
    );
  }
  return (
    <span className="ml-3 min-w-0 truncate text-caption text-muted-foreground">
      {properties.entries.map((entry) => entry.key).join(", ")}
    </span>
  );
}

function PropertiesBody({
  properties,
  failed,
  onRetry,
}: {
  properties: DocumentPropertiesDto | undefined;
  failed: boolean;
  onRetry: () => void;
}) {
  if (failed) return <InlineErrorRow message={t`Couldn't load properties.`} onRetry={onRetry} />;
  // Loading shows nothing: the rows appear when they arrive.
  if (!properties) return null;
  if (properties.unreadable) {
    return (
      <div className="flex flex-col gap-2 pt-1">
        <p className="text-caption text-muted-foreground">
          {properties.truncated ? (
            <Trans>
              These properties are too large to show in full. The start is shown as written.
            </Trans>
          ) : (
            <Trans>These properties couldn't be read, so they're shown as written.</Trans>
          )}
        </p>
        <YamlBlock text={properties.text} />
      </div>
    );
  }
  return (
    <dl
      className={cn(
        "grid grid-cols-[fit-content(10rem)_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5 pt-1",
        // In the narrow side each key sits above its value.
        "@max-md:grid-cols-1 @max-md:gap-y-0",
      )}
    >
      {properties.entries.map((entry, index) => (
        <PropertyPair key={`${index}:${entry.key}`} entry={entry} />
      ))}
    </dl>
  );
}

function PropertyPair({ entry }: { entry: DocumentPropertiesDto["entries"][number] }) {
  return (
    <>
      <dt title={entry.key} className="truncate text-caption text-muted-foreground @max-md:pt-1">
        {entry.key}
      </dt>
      <dd className="min-w-0 text-foreground text-sm">
        <DocumentPropertyValue value={entry.value} source={entry.source} />
      </dd>
    </>
  );
}
