/** /projects/new: the project library with the creation dialog open over it. */
import { t } from "@lingui/core/macro";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { useCreateProject } from "@/client/query/useProjectCreation";
import { CreationDialog } from "@/features/creation/CreationDialog";
import {
  useAccountEpochSignal,
  useAccountId,
} from "@/features/project/context/account-feature-context";
import { preloadProjectWorkspace } from "@/features/project/preload-project-workspace";
import { ProjectLibrary } from "./ProjectLibrary";

export function NewProjectView() {
  const userId = useAccountId();
  const accountSignal = useAccountEpochSignal();
  const { create } = useCreateProject(userId, accountSignal);
  const router = useRouter();
  useEffect(() => {
    // The destination UUID does not exist yet, so route preloading would run
    // owner-gated loaders into a 404. Warm only the inevitable workspace code.
    preloadProjectWorkspace();
  }, []);
  return (
    <>
      <ProjectLibrary />
      <CreationDialog
        title={t`Create a project`}
        nameLabel={t`What are you writing?`}
        namePlaceholder={t`Name your project`}
        submitLabel={t`Create project`}
        onClose={() => void router.navigate({ to: "/", replace: true })}
        onCreate={({ name }) => create({ title: name })}
      />
    </>
  );
}
