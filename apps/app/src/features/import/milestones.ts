/** Screen-reader announcements for an import's milestones. Single files are never announced. */
import { plural, t } from "@lingui/core/macro";
import { announce } from "@/client/stores/thread-store/announcements";
import { effectiveCounts } from "./import-state";
import { displayOf, type ImportStore } from "./import-store";
import { buildReportModel } from "./report-model";

/** Announce when this tab's import changes state: finished, paused, needs attention, didn't start, stopped. */
export function announceMilestones(store: ImportStore) {
  let last = displayOf(store.getSnapshot());
  return store.subscribe(() => {
    const state = store.getSnapshot();
    const next = displayOf(state);
    if (next === last) return;
    last = next;
    // Only what this tab is doing is announced: its own run, or a Stop it asked for.
    if (!state.local && state.stop === "none") return;
    switch (next) {
      case "finished": {
        const stopped =
          state.stop === "stopped" || (state.report?.summary.counts.notImported ?? 0) > 0;
        if (stopped) announce(t`Import stopped.`);
        else {
          const looks = buildReportModel(state).worthALookCount;
          announce(
            plural(looks, {
              one: "Import finished. # worth a look.",
              other: "Import finished. # worth a look.",
            }),
          );
        }
        break;
      }
      case "paused":
        announce(t`Import paused.`);
        break;
      case "needs-attention": {
        const failed = effectiveCounts(state)?.failed ?? 0;
        announce(plural(failed, { one: "# file didn't import.", other: "# files didn't import." }));
        break;
      }
      case "didnt-start":
        announce(t`Import didn't start.`);
        break;
    }
  });
}
