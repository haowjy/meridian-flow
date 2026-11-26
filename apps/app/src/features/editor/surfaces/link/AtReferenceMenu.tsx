import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { parseContextUri } from "@meridian/contracts/context-uri";
import { ChevronLeft, FilePlus2, FileText, Folder, Image } from "lucide-react";
import { useSyncExternalStore } from "react";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { EntryName } from "@/components/ui/entry-name";
import { ListLine } from "@/components/ui/list-row";
import {
  closedSuggestionMenu,
  type ReferenceBrowserMeta,
  type ReferenceMenuRow,
  type ReferenceRow,
} from "@/core/completion";
import { getAtReferenceMenu } from "@/core/editor/extensions/at-reference";
import { documentLocation, schemeLabel } from "@/features/project/context/context-schemes";
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
  const query = snapshot.query.trim();
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
      header={
        snapshot.meta?.canBacktrack ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => menu.backtrack()}
          >
            <ChevronLeft aria-hidden />
            <Trans>Back</Trans>
          </Button>
        ) : undefined
      }
      empty={
        snapshot.meta?.loadFailed ? (
          <InlineErrorRow message={<Trans>Couldn't load references.</Trans>} />
        ) : (
          <ListLine density="menu" iconSlot status>
            {snapshot.meta?.incomplete ? (
              <Trans>Loading references…</Trans>
            ) : containerLabel ? (
              <Trans>No files in {containerLabel}.</Trans>
            ) : query ? (
              <Trans>No files match “{query}”.</Trans>
            ) : (
              <Trans>No files yet.</Trans>
            )}
          </ListLine>
        )
      }
      rows={snapshot.items.map((row, index) => ({
        key: row.rowId,
        note:
          row.kind === "link-ahead" || row.kind === "folder-mention" ? undefined : rowLocation(row),
        opens: row.kind !== "link-ahead" && row.kind !== "folder-mention" && row.kind !== "file",
        before:
          row.kind === "link-ahead" && index > 0 ? (
            <div className="my-1 border-border-subtle border-t" />
          ) : undefined,
        content:
          row.kind === "link-ahead" ? (
            <>
              <FilePlus2 aria-hidden />
              <span className="truncate">{t`Link to “${row.label}” (not written yet)`}</span>
            </>
          ) : row.kind === "folder-mention" ? (
            <>
              <Folder aria-hidden />
              <span className="truncate">{t`Mention ${row.label}`}</span>
            </>
          ) : (
            <>
              <ReferenceIcon row={row} />
              <span className="min-w-0 truncate">
                <EntryName name={row.label} suffix={row.suffix} truncate />
              </span>
            </>
          ),
      }))}
    />
  );
}

function rowLocation(row: Exclude<ReferenceRow, { kind: "folder-mention" }>): string {
  if (row.kind !== "file") return row.location;
  const parsed = parseContextUri(row.action.reference.uri);
  if (!parsed.ok) return row.location;
  return documentLocation(parsed.value.scheme, row.location);
}

function ReferenceIcon({ row }: { row: Exclude<ReferenceRow, { kind: "folder-mention" }> }) {
  if (row.kind === "file")
    return row.fileKind === "asset" ? <Image aria-hidden /> : <FileText aria-hidden />;
  return <Folder aria-hidden />;
}
