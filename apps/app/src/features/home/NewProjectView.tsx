/** /projects/new: the project library with the creation dialog open over it. */
import { t } from "@lingui/core/macro";
import { useRouter } from "@tanstack/react-router";
import { useCreateProject } from "@/client/query/useProjectCreation";
import { CreationDialog } from "@/features/creation/CreationDialog";
import {
  useAccountEpochSignal,
  useAccountId,
} from "@/features/project/context/account-feature-context";
import { ProjectLibrary } from "./ProjectLibrary";

export function NewProjectView() {
  const userId = useAccountId();
  const accountSignal = useAccountEpochSignal();
  const { create } = useCreateProject(userId, accountSignal);
  const router = useRouter();
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
