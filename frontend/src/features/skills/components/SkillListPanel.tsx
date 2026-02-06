import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Plus, Sparkles } from "lucide-react";
import { useSkillStore } from "@/core/stores/useSkillStore";
import { useSkillsForProject } from "../hooks/useSkillsForProject";
import { makeLogger } from "@/core/lib/logger";
import { Button } from "@/shared/components/ui/button";
import { SkillList } from "./SkillList";
import { DeleteSkillDialog } from "./DeleteSkillDialog";
import { getErrorMessage } from "@/core/lib/errors";
import type { Skill } from "../types/skill";

const log = makeLogger("skill-list-panel");

interface SkillListPanelProps {
  projectId: string;
}

/**
 * Skills panel for viewing and managing project skills.
 * Can be used in a sidebar or as a standalone panel.
 * Navigates to SkillEditorPanel for editing skills.
 */
export function SkillListPanel({ projectId }: SkillListPanelProps) {
  const navigate = useNavigate();
  const { slug: projectSlug } = useParams({ strict: false });

  const { skills, status, isLoading, selectedSkillId, setSelectedSkillId } =
    useSkillsForProject(projectId);

  const deleteSkill = useSkillStore((s) => s.deleteSkill);

  // Delete dialog state
  const [skillToDelete, setSkillToDelete] = useState<Skill | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleSelectSkill = (skillId: string) => {
    setSelectedSkillId(skillId === selectedSkillId ? null : skillId);
  };

  // Navigate to skill editor instead of opening dialog
  const handleEditSkill = (skill: Skill) => {
    if (!projectSlug) return;
    navigate({
      to: "/projects/$slug/skills/$skillName",
      params: { slug: projectSlug, skillName: skill.name },
    });
  };

  // Navigate to create new skill
  const handleCreateSkill = () => {
    if (!projectSlug) return;
    navigate({
      to: "/projects/$slug/skills/$skillName",
      params: { slug: projectSlug, skillName: "new" },
    });
  };

  const handleDeleteClick = (skill: Skill) => {
    setSkillToDelete(skill);
  };

  const handleDeleteConfirm = async () => {
    if (!skillToDelete) return;

    setIsDeleting(true);
    try {
      await deleteSkill(projectId, skillToDelete.id);
      setSkillToDelete(null);
    } catch (error) {
      log.error("Failed to delete skill:", getErrorMessage(error));
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="bg-background relative flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-amber-500" />
          <h2 className="text-sm font-medium">Skills</h2>
          {skills.length > 0 && (
            <span className="text-muted-foreground text-xs">
              ({skills.length})
            </span>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="size-7 p-0"
          onClick={handleCreateSkill}
          disabled={isLoading}
        >
          <Plus className="size-4" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto py-2">
        {/* Blank space during loading for consistent UX */}
        {status === "loading" && <div className="px-3 py-8" />}

        {status === "error" && (
          <div className="text-destructive px-3 py-8 text-center text-sm">
            Failed to load skills
          </div>
        )}

        {status === "success" && (
          <SkillList
            skills={skills}
            selectedSkillId={selectedSkillId}
            onSelectSkill={handleSelectSkill}
            onEditSkill={handleEditSkill}
            onDeleteSkill={handleDeleteClick}
          />
        )}
      </div>

      {/* Delete dialog */}
      <DeleteSkillDialog
        skill={skillToDelete}
        open={skillToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setSkillToDelete(null);
        }}
        onConfirm={handleDeleteConfirm}
        isDeleting={isDeleting}
      />
    </div>
  );
}
