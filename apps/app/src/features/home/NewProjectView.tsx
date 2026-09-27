/** Library-level project creation destination. */
import { Trans } from "@lingui/react/macro";
import { useRef } from "react";
import { useCreateProject } from "@/client/query/useProjectCreation";
import { Input } from "@/components/ui/input";
import { CreationPage } from "@/features/creation/CreationPage";
import {
  useAccountEpochSignal,
  useAccountId,
} from "@/features/project/context/account-feature-context";

export function NewProjectView() {
  const userId = useAccountId();
  const accountSignal = useAccountEpochSignal();
  const { create } = useCreateProject(userId, accountSignal);
  const nameRef = useRef<HTMLInputElement>(null);

  return (
    <CreationPage
      backTo="/"
      backLabel="View projects"
      title="New project"
      submitLabel="Create project"
      onSubmit={() => create({ title: nameRef.current?.value ?? "" })}
    >
      <div className="grid gap-1.5">
        <label htmlFor="project-title" className="text-sm font-medium">
          <Trans>Project name</Trans>
        </label>
        <Input
          ref={nameRef}
          id="project-title"
          name="creation-name"
          autoFocus
          autoComplete="off"
          maxLength={120}
          placeholder="Name your project"
          className="h-[38px] bg-card text-[15px]"
        />
      </div>
    </CreationPage>
  );
}
