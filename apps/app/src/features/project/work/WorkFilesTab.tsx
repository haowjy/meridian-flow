/** The Work page's Files tab: its search, Upload and New note, over the grouped files. */
import { t } from "@lingui/core/macro";
import { useState } from "react";
import type { AddressableWork } from "@/client/query/useWorks";
import type { ProjectRouteCommands } from "../routing/project-route";
import { SearchField } from "../SearchField";
import { useWorkFiles, WorkFilesActions, WorkFilesView } from "./WorkFilesView";
import { WorkToolbarTools } from "./WorkToolbarSlot";

export function WorkFilesTab({
  projectId,
  work,
  readOnly,
  commands,
}: {
  projectId: string;
  work: AddressableWork;
  readOnly: boolean;
  commands: ProjectRouteCommands;
}) {
  // Filtering is local to loaded rows, so it follows every keystroke.
  const [search, setSearch] = useState("");
  const files = useWorkFiles(projectId, work);
  return (
    <>
      <WorkToolbarTools>
        <SearchField label={t`Search files`} value={search} onChange={setSearch} />
        <WorkFilesActions files={files} readOnly={readOnly} />
      </WorkToolbarTools>
      <WorkFilesView
        projectId={projectId}
        work={work}
        readOnly={readOnly}
        commands={commands}
        search={search}
        files={files}
      />
    </>
  );
}
