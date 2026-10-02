import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { parseContextUri } from "@meridian/contracts/context-uri";
import { ChevronLeft, ChevronRight, FilePlus2, FileText, Folder, Image } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import {
  closedSuggestionMenu,
  type ReferenceBrowserMeta,
  type ReferenceMenuRow,
  type ReferenceRow,
} from "@/core/completion";
import { getAtReferenceMenu } from "@/core/editor/extensions/at-reference";
import { schemeLabel } from "@/features/project/context/context-schemes";
import { type EditorChromeSurfaceProps, SuggestionMenu } from "../../chrome";

const NO_SUBSCRIPTION = () => () => {};
const closed = () => closedSuggestionMenu<ReferenceMenuRow, ReferenceBrowserMeta>();
export function AtReferenceMenu({ editor }: EditorChromeSurfaceProps) {
  const menu = getAtReferenceMenu(editor);
  return (
    <ReferenceSuggestionMenu
      editor={editor}
      menu={menu}
      ownerId="at-reference-menu"
      typingElement={editor.view.dom}
    />
  );
}

export function ReferenceSuggestionMenu({
  editor,
  menu,
  ownerId,
  typingElement,
}: {
  editor: EditorChromeSurfaceProps["editor"];
  menu: ReturnType<typeof getAtReferenceMenu>;
  ownerId: string;
  typingElement: HTMLElement;
}) {
  const snapshot = useSyncExternalStore(
    menu?.subscribe ?? NO_SUBSCRIPTION,
    () => menu?.snapshot() ?? closed(),
    closed,
  );
  const containerLabel =
    snapshot.meta?.containerLabel ??
    (snapshot.meta?.containerScheme ? schemeLabel(snapshot.meta.containerScheme) : null);
  if (!menu) return null;
  return (
    <SuggestionMenu
      editor={editor}
      typingElement={typingElement}
      id={ownerId}
      open={snapshot.open}
      label={snapshot.label}
      anchorRect={snapshot.anchorRect}
      activeIndex={snapshot.activeIndex}
      onActivate={(index) => menu.setActiveIndex(index)}
      onChoose={(index) => menu.choose(index)}
      onDismiss={menu.dismiss}
      className="max-w-96"
      note={
        snapshot.items.length === 0 || snapshot.meta?.canBacktrack ? (
          <div className="flex flex-col gap-1">
            {snapshot.meta?.canBacktrack ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="justify-start"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => menu.backtrack()}
              >
                <ChevronLeft aria-hidden />
                <Trans>Back</Trans>
              </Button>
            ) : null}
            {snapshot.items.length === 0 ? (
              <span role="status" className="px-2 py-1">
                {snapshot.meta?.loadFailed ? (
                  <Trans>Couldn't load references.</Trans>
                ) : snapshot.meta?.incomplete ? (
                  <Trans>Loading references…</Trans>
                ) : containerLabel ? (
                  <Trans>No files in {containerLabel}.</Trans>
                ) : (
                  <Trans>No matching files</Trans>
                )}
              </span>
            ) : null}
          </div>
        ) : undefined
      }
      rows={snapshot.items.map((row, index) => ({
        key: row.rowId,
        before:
          // The link-ahead row is a different kind of answer: everything above
          // it exists, and it does not yet.
          row.kind === "link-ahead" && index > 0 ? (
            <div className="my-1 border-border-subtle border-t" />
          ) : undefined,
        content:
          row.kind === "link-ahead" ? (
            <>
              <FilePlus2 aria-hidden />
              {/* It writes a link, not a document: Create is offered when the
                  link is followed. */}
              <span className="truncate">{t`Link to “${row.label}” (not written yet)`}</span>
            </>
          ) : (
            <>
              <ReferenceIcon row={row} />
              <span className="truncate">{row.label}</span>
              <span className="ml-auto shrink-0 pl-4 text-ink-subtle text-xs">
                {rowLocation(row)}
              </span>
              {row.kind !== "file" ? <ChevronRight aria-hidden /> : null}
            </>
          ),
      }))}
    />
  );
}

/**
 * Where a file lives, so two documents with one name are told apart: its
 * folder, after the area it is in unless that is the manuscript.
 */
function rowLocation(row: ReferenceRow): string {
  if (row.kind !== "file") return row.location;
  const parsed = parseContextUri(row.action.reference.uri);
  if (!parsed.ok || parsed.value.scheme === "manuscript") return row.location;
  const area = schemeLabel(parsed.value.scheme);
  return row.location ? `${area}/${row.location}` : area;
}

function ReferenceIcon({ row }: { row: ReferenceRow }) {
  if (row.kind === "file")
    return row.fileKind === "asset" ? <Image aria-hidden /> : <FileText aria-hidden />;
  return <Folder aria-hidden />;
}
