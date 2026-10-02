/** The Work page's Files tab: its search and New note, over Drafts and Scratch. */
import { t } from "@lingui/core/macro";
import { useState } from "react";
import type { AddressableWork } from "@/client/query/useWorks";
import { SearchField } from "../SearchField";
import { useWorkFiles, WorkFilesActions, WorkFilesView } from "./WorkFilesView";
import { WorkToolbarTools } from "./WorkToolbarSlot";

export function WorkFilesTab({ projectId, work }: { projectId: string; work: AddressableWork }) {
  // Filtering is local to loaded rows, so it follows every keystroke.
  const [search, setSearch] = useState("");
  const files = useWorkFiles(projectId, work);
  return (
    <>
      <WorkToolbarTools>
        <SearchField label={t`Search files`} value={search} onChange={setSearch} />
        <WorkFilesActions files={files} />
      </WorkToolbarTools>
      <WorkFilesView projectId={projectId} work={work} search={search} files={files} />
    </>
  );
}
