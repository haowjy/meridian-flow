/** Screen-reader announcements for an import's milestones. Single files are never announced. */
import { plural, t } from "@lingui/core/macro";
import { announce } from "@/client/stores/thread-store/announcements";
import { effectiveCounts } from "./import-state";
import { displayOf, type ImportStore } from "./import-store";

/** Announce when this tab's import changes state: finished, stopped, interrupted, files failed, didn't start. */
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
        announce(stopped ? t`Import stopped.` : t`Import finished.`);
        break;
      }
      case "paused":
        announce(t`Import stopped partway.`);
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
