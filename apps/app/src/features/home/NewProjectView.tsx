import { t } from "@lingui/core/macro";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { useCreateProject } from "@/client/query/useProjectCreation";
import { notifyFailure } from "@/components/app/failure-toast";
import { CreationDialog } from "@/features/creation/CreationDialog";
import { preloadProjectWorkspace } from "@/features/project/preload-project-workspace";
import { ProjectLibrary } from "./ProjectLibrary";

export function NewProjectView() {
  const { create } = useCreateProject();
  const router = useRouter();
  useEffect(() => {
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
        onCreate={({ name }) =>
          create({ title: name }).catch(() =>
            notifyFailure({ key: "project-create", title: t`Couldn't create` }),
          )
        }
      />
    </>
  );
}
