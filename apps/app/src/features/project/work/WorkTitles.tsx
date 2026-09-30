/**
 * A Work's two titles: the active tab in the pane band (navigation chrome) and
 * the page heading (the page's own identity). Both rename the same Work in
 * place through `TitleEditSlot`, without moving the text: a rename shows at
 * once, and a refused one reopens the title that was edited. An archived Work
 * shows the same titles as plain text, as does a Work with no server identity
 * yet (its name only, through the `Plain*` titles).
 * Both are one line: a long name truncates, with the full name on hover and as
 * the accessible name; the rename field scrolls within that line.
 */
import { t } from "@lingui/core/macro";
import { isWorkArchived, type Work } from "@meridian/contracts/works";
import { useWorkMutations } from "@/client/query/work-command-store";
import { cn } from "@/lib/utils";
import { TitleEditSlot } from "../shell/TitleEditSlot";
import { titleChipClass } from "../shell/title-chip";

// The heading shrinks beside the status; it clips nothing itself, so a refused
// rename's message can hang below it. The text inside truncates instead.
const headingClass = "relative flex min-w-0 text-xl font-semibold tracking-tight";

/** Renames the Work; rejects when the server refused it. */
function useWorkRename(projectId: string, work: Work) {
  const { update } = useWorkMutations(projectId);
  return async (name: string) => {
    const error = await update({ workId: work.id, data: { name } });
    if (error) throw error;
  };
}

export function WorkTitleTab({
  projectId,
  work,
  variant,
}: {
  projectId: string;
  work: Work;
  variant: "tab" | "quiet";
}) {
  const rename = useWorkRename(projectId, work);
  if (isWorkArchived(work)) return <PlainWorkTitleTab name={work.name} variant={variant} />;
  return (
    <div className={cn(titleChipClass(variant), "relative")}>
      <TitleEditSlot
        titleKey={`work:${work.id}`}
        label={t`Rename Work`}
        failure={t`Couldn’t rename this Work. Try again.`}
        rename={rename}
      >
        {({ start, triggerRef }) => (
          <span className="flex min-w-0 px-1">
            <button
              ref={triggerRef}
              type="button"
              aria-label={t`Rename Work: ${work.name}`}
              title={work.name}
              onClick={() => start(work.name)}
              className="pane-title inline-edit-trigger focus-ring min-w-0 truncate text-left"
            >
              {work.name}
            </button>
          </span>
        )}
      </TitleEditSlot>
    </div>
  );
}

/** The Work page's heading, renamed in place like the tab above it. */
export function WorkHeading({ projectId, work }: { projectId: string; work: Work }) {
  const rename = useWorkRename(projectId, work);
  if (isWorkArchived(work)) return <PlainWorkHeading name={work.name} />;
  return (
    <h1 className={headingClass}>
      <TitleEditSlot
        titleKey={`work:${work.id}`}
        label={t`Rename Work`}
        failure={t`Couldn’t rename this Work. Try again.`}
        rename={rename}
        fieldClassName="flex min-w-0"
      >
        {({ start, triggerRef }) => (
          // The heading's accessible name stays the Work's name, and the
          // tooltip shows it whole when it truncates.
          <button
            ref={triggerRef}
            type="button"
            title={work.name}
            onClick={() => start(work.name)}
            className="inline-edit-trigger focus-ring min-w-0 truncate text-left"
          >
            {work.name}
          </button>
        )}
      </TitleEditSlot>
    </h1>
  );
}

/**
 * A Work's name in the tab as plain text. Outside this module, only for a Work
 * still being created, which has a name but nothing to rename yet.
 */
export function PlainWorkTitleTab({ name, variant }: { name: string; variant: "tab" | "quiet" }) {
  return (
    <div className={titleChipClass(variant)}>
      <span title={name} className="pane-title min-w-0 truncate px-1">
        {name}
      </span>
    </div>
  );
}

/** A Work's heading as plain text; outside this module, only for a Work still being created. */
export function PlainWorkHeading({ name }: { name: string }) {
  return (
    <h1 className={headingClass}>
      <span title={name} className="min-w-0 truncate">
        {name}
      </span>
    </h1>
  );
}
