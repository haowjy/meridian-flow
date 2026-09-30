/**
 * A Work's two titles: the active tab in the pane band (navigation chrome) and
 * the page heading (the page's own identity). Both rename the same Work in
 * place through `TitleEditSlot`, without moving the text: a rename shows at
 * once, and a refused one reopens the title that was edited. A Work with no
 * server identity yet, or an archived one, shows the same titles as plain text.
 */
import { t } from "@lingui/core/macro";
import type { Work } from "@meridian/contracts/works";
import { useWorkMutations } from "@/client/query/work-command-store";
import { cn } from "@/lib/utils";
import { TitleEditSlot } from "../shell/TitleEditSlot";
import { titleChipClass } from "../shell/title-chip";

const headingClass = "min-w-0 text-xl font-semibold tracking-tight [overflow-wrap:anywhere]";

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
  return (
    <h1 className={cn(headingClass, "relative")}>
      <TitleEditSlot
        titleKey={`work:${work.id}`}
        label={t`Rename Work`}
        failure={t`Couldn’t rename this Work. Try again.`}
        rename={rename}
        fieldClassName="flex min-w-0"
      >
        {({ start, triggerRef }) => (
          // The heading's accessible name stays the Work's name; the tooltip
          // says what clicking it does.
          <button
            ref={triggerRef}
            type="button"
            title={t`Rename`}
            onClick={() => start(work.name)}
            className="inline-edit-trigger focus-ring text-left"
          >
            {work.name}
          </button>
        )}
      </TitleEditSlot>
    </h1>
  );
}

/** A Work's name in the tab, not editable: still being created, or archived. */
export function PlainWorkTitleTab({ name, variant }: { name: string; variant: "tab" | "quiet" }) {
  return (
    <div className={titleChipClass(variant)}>
      <span title={name} className="pane-title min-w-0 truncate px-1">
        {name}
      </span>
    </div>
  );
}

/** A Work's heading, not editable: still being created, or archived. */
export function PlainWorkHeading({ name }: { name: string }) {
  return <h1 className={headingClass}>{name}</h1>;
}
