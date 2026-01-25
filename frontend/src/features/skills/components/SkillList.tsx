import type { Skill } from '../types/skill'
import { SkillListItem } from './SkillListItem'

interface SkillListProps {
  skills: Skill[]
  selectedSkillId: string | null
  onSelectSkill: (skillId: string) => void
  onEditSkill: (skill: Skill) => void
  onDeleteSkill: (skill: Skill) => void
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
      <div className="px-3 py-8 text-center text-muted-foreground">
        <p className="text-sm">No skills yet.</p>
        <p className="text-xs mt-1">Create your first skill to get started.</p>
      </div>
    )
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
  )
}
