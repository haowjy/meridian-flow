import { i18n } from "@lingui/core";
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ListDiscardEntriesResponse } from "@meridian/contracts/branches";
import { ArchiveRestore } from "lucide-react";
import { RowWord } from "@/components/app/RowWord";
import { ListRow } from "@/components/ui/list-row";
import { leftOutSentence, restoreReturnedSentence } from "@/features/draft-review/CommandNotice";
import type { DiscardRestoreState } from "@/features/draft-review/discard-restores";
import { fileKindIcon } from "../../context/context-file-icon";
import { relativeTime } from "../../relative-time";

export type DiscardEntry = ListDiscardEntriesResponse["entries"][number];

/**
 * A Discard in Trash: the drafts it took, by name, and the Work it took them from, its age at the
 * right; its menu restores them. What became of a restore is the row's word: restored (the row
 * stays, struck through), not restored and why, or Retry.
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
  /** The Undo's Discard is on its way, or was refused. */
  undo?: "sending" | "failed";
}) {
  const title =
    names.length > 0
      ? new Intl.ListFormat(i18n.locale || undefined, { type: "conjunction" }).format(names)
      : t`Changes`;
  const icon = fileKindIcon(names[0] ?? "");
  const detail = <span className="truncate">{discardedFrom(entry, names.length, workName)}</span>;
  if (state?.kind === "restored")
    return (
      <ListRow
        gone
        icon={icon}
        title={title}
        detail={detail}
        notice={
          undo === "failed" ? (
            <RowWord
              tone="warning"
              word={<Trans>Retry</Trans>}
              label={t`Retry undoing the restore of ${title}`}
              sentence={t`Undo didn't go through. Try again.`}
              onAction={onUndo}
            />
          ) : !onUndo ? (
            // Restored elsewhere first: nothing here can put it back.
            <RowWord tone="done" word={<Trans>Restored</Trans>} sentence={t`Restored just now.`} />
          ) : (
            <RowWord
              word={<Trans>Undo</Trans>}
              label={t`Undo restore of ${title}`}
              sentence={
                workName
                  ? t`Restored just now: the drafts are back in ${workName}. Undo puts them back in Trash.`
                  : t`Restored just now: the drafts are back. Undo puts them back in Trash.`
              }
              pending={undo === "sending"}
              onAction={onUndo}
            />
          )
        }
      />
    );
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
        state?.kind === "failed" ? (
          <RowWord
            tone="warning"
            word={<Trans>Retry</Trans>}
            label={t`Retry restoring ${title}`}
            sentence={t`Couldn't restore it. Retry tries again.`}
            onAction={onRestore}
          />
        ) : state?.kind === "restoring" ? (
          <RowWord word={<Trans>Restoring</Trans>} sentence={t`Restoring the drafts.`} pending />
        ) : state?.kind === "returned" ? (
          <RowWord
            tone="warning"
            word={<Trans>Not restored</Trans>}
            sentence={restoreReturnedSentence(state.why)}
          />
        ) : state?.kind === "left_out" ? (
          <RowWord
            tone="warning"
            word={<Trans>Not restored</Trans>}
            sentence={leftOutSentence(state.leftOut)}
          />
        ) : null
      }
    />
  );
}

/** What took them and from where: a Discard, or a restore that put an older draft back. */
function discardedFrom(entry: DiscardEntry, count: number, workName: string | null): string {
  if (entry.kind === "undo_discard")
    return workName ? t`Replaced by a restore in ${workName}` : t`Replaced by a restore`;
  if (count <= 1) return workName ? t`Draft discarded from ${workName}` : t`Draft discarded`;
  return workName
    ? plural(count, {
        one: `# draft discarded from ${workName}`,
        other: `# drafts discarded from ${workName}`,
      })
    : plural(count, { one: "# draft discarded", other: "# drafts discarded" });
}
