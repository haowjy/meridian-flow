import type { Skill } from "../types/skill";
import { SkillListItem } from "./SkillListItem";

interface SkillListProps {
  skills: Skill[];
  selectedSkillId: string | null;
  onSelectSkill: (skillId: string) => void;
  onEditSkill: (skill: Skill) => void;
  onDeleteSkill: (skill: Skill) => void;
}

export function SkillList({
  skills,
  selectedSkillId,
  onSelectSkill,
  onEditSkill,
  onDeleteSkill,
}: SkillListProps) {
  if (skills.length === 0) {
    return (
      <div className="text-muted-foreground px-3 py-8 text-center">
        <p className="text-sm">No skills yet.</p>
        <p className="mt-1 text-xs">Create your first skill to get started.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5 px-2">
      {skills.map((skill) => (
        <SkillListItem
          key={skill.id}
          skill={skill}
          isSelected={skill.id === selectedSkillId}
          onSelect={() => onSelectSkill(skill.id)}
          onEdit={() => onEditSkill(skill)}
          onDelete={() => onDeleteSkill(skill)}
        />
      ))}
    </div>
  );
}
