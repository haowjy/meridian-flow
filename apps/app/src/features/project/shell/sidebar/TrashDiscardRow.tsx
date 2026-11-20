import { i18n } from "@lingui/core";
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ListDiscardEntriesResponse } from "@meridian/contracts/branches";
import { ArchiveRestore } from "lucide-react";
import { RowWord } from "@/components/app/RowWord";
import { ListRow } from "@/components/ui/list-row";
import type { DiscardRestoreState } from "@/features/draft-review/discard-restores";
import { fileKindIcon } from "../../context/context-file-icon";
import { relativeTime } from "../../relative-time";

export type DiscardEntry = ListDiscardEntriesResponse["entries"][number];

/**
 * A Discard in Trash: the drafts it took, by name, and the Work it took them from, its age at the
 * right; its menu restores them. A restored row stays, struck through, with its Undo; a failed
 * restore is the pill's.
 */
export function TrashDiscardRow({
  entry,
  names,
  workName,
  now,
  state,
  onRestore,
  onUndo,
  undo,
}: {
  entry: DiscardEntry;
  /** The documents it took, by name: what the writer looks for. */
  names: readonly string[];
  workName: string | null;
  now: number;
  state: DiscardRestoreState | undefined;
  onRestore: () => void;
  /** Undo of a restore made here: Discard the same drafts again. Absent until it can be sent. */
  onUndo?: () => void;
  /** The Undo's Discard is on its way. */
  undo?: boolean;
}) {
  const title =
    names.length > 0
      ? new Intl.ListFormat(i18n.locale || undefined, { type: "conjunction" }).format(names)
      : t`Changes`;
  const icon = fileKindIcon(names[0] ?? "");
  const detail = <span className="truncate">{discardedFrom(names.length, workName)}</span>;
  if (state?.kind === "restored") {
    return (
      <ListRow
        gone
        icon={icon}
        title={title}
        detail={detail}
        notice={
          !onUndo ? (
            // Restored elsewhere first: nothing here can put it back.
            <RowWord tone="done" word={<Trans>Restored</Trans>} />
          ) : (
            <RowWord
              word={<Trans>Undo</Trans>}
              label={t`Undo restore of ${title}`}
              pending={undo}
              onAction={onUndo}
            />
          )
        }
      />
    );
  }
  return (
    <ListRow
      icon={icon}
      title={title}
      meta={relativeTime(entry.at, now)}
      detail={detail}
      // A Discard has no page of its own: its menu restores it.
      onOpen={() => {}}
      menu={{
        groups: [[{ id: "restore", label: <Trans>Restore</Trans>, icon: ArchiveRestore }]],
        onSelect: onRestore,
      }}
      revealActions
      notice={
        state?.kind === "restoring" ? (
          <RowWord word={<Trans>Restoring</Trans>} sentence={t`Restoring the drafts.`} pending />
        ) : null
      }
    />
  );
}

/** What took them and from where. */
function discardedFrom(count: number, workName: string | null): string {
  if (count <= 1) return workName ? t`Draft discarded from ${workName}` : t`Draft discarded`;
  return workName
    ? plural(count, {
        one: `# draft discarded from ${workName}`,
        other: `# drafts discarded from ${workName}`,
      })
    : plural(count, { one: "# draft discarded", other: "# drafts discarded" });
}
