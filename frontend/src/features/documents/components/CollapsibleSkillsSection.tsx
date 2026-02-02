import { useState } from 'react'
import { Sparkles, Loader2, Plus } from 'lucide-react'
import { Collapsible, CollapsibleContent } from '@/shared/components/ui/collapsible'
import { Button } from '@/shared/components/ui/button'
import { useSkillsForProject } from '@/features/skills/hooks/useSkillsForProject'
import { SkillTreeItem } from './SkillTreeItem'
import { SelectableTreeItem } from './SelectableTreeItem'
import type { Skill } from '@/features/skills/types/skill'

interface CollapsibleSkillsSectionProps {
  projectId: string
  activeSkillId: string | null
  onSkillClick: (skillId: string) => void
  onDeleteSkill: (skillId: string, skill: Skill) => void
  onCreateSkill?: () => void
}

/**
 * Collapsible skills section for the document tree.
 * Styled like a folder tree item with collapsible functionality.
 * Default collapsed, no persistence.
 * Always visible (even with 0 skills) to make skill creation discoverable.
 */
export function CollapsibleSkillsSection({
  projectId,
  activeSkillId,
  onSkillClick,
  onDeleteSkill,
  onCreateSkill,
}: CollapsibleSkillsSectionProps) {
  const { skills, status } = useSkillsForProject(projectId)
  const [isExpanded, setIsExpanded] = useState(false) // Default collapsed

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      {/* Folder-style header with hover effect */}
      <div className="group flex w-full items-center rounded-sm text-left text-sm transition-colors hover:bg-hover">
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex flex-1 min-w-0 items-center gap-2 px-2.5 py-2 md:py-1 cursor-pointer appearance-none bg-transparent border-none m-0 font-inherit text-inherit text-left"
          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} skills section`}
          aria-expanded={isExpanded}
        >
          <Sparkles className="size-4 md:size-3.5 flex-shrink-0 text-primary" />
          <span className="truncate font-medium">Skills</span>
          {skills.length > 0 && (
            <span className="text-muted-foreground text-xs ml-1">({skills.length})</span>
          )}
        </button>

        {/* Action button - visible on hover (desktop) or always (mobile) */}
        {onCreateSkill && (
          <Button
            variant="ghost"
            size="icon"
            className="flex-shrink-0 h-7 w-9 md:h-4 md:w-7 p-0 rounded-sm transition-opacity opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"
            onClick={(e) => {
              e.stopPropagation()
              onCreateSkill()
            }}
            aria-label="New skill"
          >
            <Plus className="size-4.5 md:size-4" />
          </Button>
        )}
      </div>

      {/* Children container */}
      <CollapsibleContent className="overflow-hidden">
        <div className="tree-children">
          {status === 'loading' ? (
            <div className="flex items-center gap-2 px-2.5 py-0.5 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin shrink-0" />
              <span className="text-sm">Loading...</span>
            </div>
          ) : skills.length === 0 ? (
            <div className="flex items-center gap-2 px-2.5 py-0.5 text-muted-foreground">
              <span className="text-sm">No skills yet</span>
            </div>
          ) : (
            skills.map((skill) => (
              <SelectableTreeItem key={skill.id} id={skill.id}>
                <SkillTreeItem
                  skill={skill}
                  isActive={activeSkillId === skill.id}
                  onClick={onSkillClick}
                  onDelete={onDeleteSkill}
                />
              </SelectableTreeItem>
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
