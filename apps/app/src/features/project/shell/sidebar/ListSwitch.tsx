import { t } from "@lingui/core/macro";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { SIDEBAR_LIST_KEYS, SIDEBAR_LISTS, useSidebarListState } from "./sidebar-lists";

/** The Write | Chat switch: it picks the sidebar's list and nothing else. */
export function ListSwitch({ projectId, className }: { projectId: string; className?: string }) {
  const { list, setList } = useSidebarListState(projectId);
  return (
    <SegmentedTabs
      label={t`Sidebar list`}
      fill
      className={className}
      value={list}
      options={SIDEBAR_LIST_KEYS.map((key) => ({
        value: key,
        label: SIDEBAR_LISTS[key].label(),
        icon: SIDEBAR_LISTS[key].icon,
      }))}
      onChange={setList}
    />
  );
}
