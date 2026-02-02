import { useState, useCallback } from 'react'
import { ChevronLeft } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { getErrorMessage } from '@/core/lib/errors'
import { makeLogger } from '@/core/lib/logger'
import { Button } from '@/shared/components/ui/button'
import { useSkillStore } from '@/core/stores/useSkillStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { DocumentHeaderBar } from '@/features/documents/components/DocumentHeaderBar'
import { DocumentTreeToggle } from '@/shared/components/layout'
import { normalizeSkillName, validateSkillName } from '../lib/skillValidation'
import { SkillForm } from './SkillForm'

const log = makeLogger('skill-create-panel')

interface SkillCreatePanelProps {
  projectId: string
  projectSlug: string
  // Mobile navigation: callback to navigate back to tree view
  onBackToTree?: () => void
}

/**
 * Skill creation panel with inline editor.
 * Uses shared SkillForm for form fields.
 * Creates skill via API, then navigates to editor.
 */
export function SkillCreatePanel({ projectId, projectSlug, onBackToTree }: SkillCreatePanelProps) {
  const navigate = useNavigate()
  const { createSkill } = useSkillStore()
  const documentTreeCollapsed = useUIStore((s) => s.documentTreeCollapsed)

  // Local form state
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')

  // Track which fields have been touched (for validation display)
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set())

  // Submission state
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // Derive validation state
  const nameValidation = validateSkillName(name)
  const isDescriptionEmpty = description.trim() === ''
  const isContentEmpty = content.trim() === ''

  // Form is valid if all required fields are filled and name is valid
  const canCreate =
    nameValidation.error === undefined &&
    !isDescriptionEmpty &&
    !isContentEmpty

  // Show validation errors only if field was touched and is invalid
  const descriptionError = touchedFields.has('description') && isDescriptionEmpty
    ? 'Description is required'
    : undefined
  const contentError = touchedFields.has('content') && isContentEmpty
    ? 'Instructions are required'
    : undefined

  // Handle field changes with touched tracking
  const handleNameChange = useCallback((value: string) => {
    setName(value)
    setSubmitError(null)  // Clear API error when user tries again
  }, [])

  const handleDescriptionChange = useCallback((value: string) => {
    setDescription(value)
    setTouchedFields((prev) => new Set(prev).add('description'))
  }, [])

  const handleContentChange = useCallback((value: string) => {
    setContent(value)
    setTouchedFields((prev) => new Set(prev).add('content'))
  }, [])

  // Handle create
  const handleCreate = useCallback(async () => {
    if (!canCreate) return

    setIsSubmitting(true)
    setSubmitError(null)

    try {
      const normalizedName = normalizeSkillName(name)
      const skill = await createSkill(projectId, {
        name: normalizedName,
        description: description.trim(),
        content: content.trim(),
      })

      // Navigate to the newly created skill's editor
      navigate({
        to: '/projects/$slug/skills/$skillName',
        params: { slug: projectSlug, skillName: skill.name },
        replace: true,  // Replace so back button doesn't return to /new
      })
    } catch (err) {
      const message = getErrorMessage(err)
      log.error('Failed to create skill:', message)
      setSubmitError(message)
      setIsSubmitting(false)
    }
  }, [canCreate, name, description, content, projectId, createSkill, navigate, projectSlug])

  // Handle cancel - navigate back
  const handleCancel = useCallback(() => {
    // Navigate to project threads (default landing)
    navigate({
      to: '/projects/$slug/threads',
      params: { slug: projectSlug },
    })
  }, [navigate, projectSlug])

  // Combine mobile back button + document tree toggle for leading slot
  const mobileBackButton = onBackToTree ? (
    <Button
      variant="ghost"
      size="icon"
      onClick={onBackToTree}
      aria-label="Back to document tree"
      className="size-8"
    >
      <ChevronLeft className="size-5" />
    </Button>
  ) : null

  const leadingContent = (
    <>
      {mobileBackButton && <div className="md:hidden">{mobileBackButton}</div>}
      {documentTreeCollapsed && <div className="hidden md:block"><DocumentTreeToggle /></div>}
    </>
  )

  const hasLeadingContent = mobileBackButton || documentTreeCollapsed

  // Determine which validation error to show in header
  const headerValidationError = !canCreate
    ? (nameValidation.error ||
       (isDescriptionEmpty ? 'Description required' : 'Instructions required'))
    : undefined

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <DocumentHeaderBar
        leading={hasLeadingContent ? leadingContent : undefined}
        title={
          <span className="text-sm font-medium text-muted-foreground">
            /new-skill
          </span>
        }
        trailing={
          <div className="flex items-center gap-2">
            {/* API error */}
            {submitError && (
              <span
                className="text-sm text-destructive max-w-[200px] truncate"
                title={submitError}
              >
                {submitError}
              </span>
            )}
            {/* Validation hint (only when fields are touched) */}
            {!submitError && touchedFields.size > 0 && headerValidationError && (
              <span className="text-sm text-destructive">
                {headerValidationError}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCancel}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={!canCreate || isSubmitting}
            >
              {isSubmitting ? 'Creating...' : 'Create'}
            </Button>
          </div>
        }
        ariaLabel="Create new skill"
        showDivider={false}
      />

      {/* Content area - uses shared SkillForm */}
      <div className="flex-1 overflow-hidden">
        <SkillForm
          name={name}
          description={description}
          content={content}
          onNameChange={handleNameChange}
          onDescriptionChange={handleDescriptionChange}
          onContentChange={handleContentChange}
          nameError={nameValidation.error || submitError || undefined}
          descriptionError={descriptionError}
          contentError={contentError}
          showNameHint={true}
          disabled={isSubmitting}
        />
      </div>
    </div>
  )
}
