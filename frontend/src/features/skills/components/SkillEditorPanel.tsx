import { useState, useEffect, useCallback, useRef } from 'react'
import { ChevronLeft } from 'lucide-react'
import { api } from '@/core/lib/api'
import { getErrorMessage } from '@/core/lib/errors'
import { makeLogger } from '@/core/lib/logger'
import { Button } from '@/shared/components/ui/button'
import { useSkillStore } from '@/core/stores/useSkillStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { useNavigate } from '@tanstack/react-router'
import type { SkillWithContent } from '../types/skill'
import { DocumentHeaderBar } from '@/features/documents/components/DocumentHeaderBar'
import { DocumentTreeToggle } from '@/shared/components/layout'
import { normalizeSkillName, validateSkillName } from '../lib/skillValidation'
import { SkillForm } from './SkillForm'

const log = makeLogger('skill-editor-panel')

interface SkillEditorPanelProps {
  skillId: string
  projectId: string
  projectSlug: string
  // Mobile navigation: callback to navigate back to tree view
  onBackToTree?: () => void
}

/**
 * Skill editor panel showing metadata fields + CodeMirror editor.
 * Network-first loading (no IndexedDB caching).
 * Manual save with Cancel to revert unsaved changes.
 */
export function SkillEditorPanel({ skillId, projectId, projectSlug, onBackToTree }: SkillEditorPanelProps) {
  const [skill, setSkill] = useState<SkillWithContent | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  // API error message for inline display (e.g., duplicate name conflict)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Local editing state
  const [localName, setLocalName] = useState('')
  const [localDescription, setLocalDescription] = useState('')
  const [localContent, setLocalContent] = useState('')

  // Track which fields have been touched (for validation display)
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set())

  const abortControllerRef = useRef<AbortController | null>(null)
  // Track save status timeout for cleanup
  const saveStatusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Get store action for updating skills (updates both API and local state)
  const { updateSkill } = useSkillStore()
  const documentTreeCollapsed = useUIStore((s) => s.documentTreeCollapsed)
  const navigate = useNavigate()

  // Load skill content on mount or when skillId changes
  useEffect(() => {
    let ignore = false

    // Cancel previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    const abortController = new AbortController()
    abortControllerRef.current = abortController

    async function loadSkill() {
      setIsLoading(true)
      setError(null)

      try {
        const loadedSkill = await api.skills.get(projectId, skillId, { signal: abortController.signal })
        if (!ignore) {
          setSkill(loadedSkill)
          setLocalName(loadedSkill.name)
          setLocalDescription(loadedSkill.description)
          setLocalContent(loadedSkill.content)
          setTouchedFields(new Set())
          setSaveStatus('idle')
          setSaveError(null)
        }
      } catch (err) {
        if (!ignore && (err as Error).name !== 'AbortError') {
          const message = getErrorMessage(err)
          setError(message)
        }
      } finally {
        if (!ignore) {
          setIsLoading(false)
        }
      }
    }

    loadSkill()

    return () => {
      ignore = true
      abortController.abort()
    }
  }, [skillId, projectId])

  // Cleanup save status timeout on unmount
  useEffect(() => {
    return () => {
      if (saveStatusTimeoutRef.current) {
        clearTimeout(saveStatusTimeoutRef.current)
      }
    }
  }, [])

  // Derive dirty state and validation
  const hasChanges = skill && (
    localName !== skill.name ||
    localDescription !== skill.description ||
    localContent !== skill.content
  )

  // Derive validation state (no useState needed - computed from localName)
  const nameValidation = validateSkillName(localName)

  // Validation for save button (name valid + required fields non-empty)
  const isDescriptionEmpty = localDescription.trim() === ''
  const isContentEmpty = localContent.trim() === ''
  const canSave =
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

  // Handle manual save
  const handleSave = useCallback(async () => {
    if (!skill || !canSave) return

    setSaveStatus('saving')
    setSaveError(null)

    try {
      const normalizedName = normalizeSkillName(localName)
      const previousName = skill.name

      // Only send fields that actually changed to reduce unnecessary backend work
      const updates: { name?: string; description?: string; content?: string } = {}
      if (normalizedName !== skill.name) updates.name = normalizedName
      if (localDescription.trim() !== skill.description) updates.description = localDescription.trim()
      if (localContent.trim() !== skill.content) updates.content = localContent.trim()

      const updatedSkill = await updateSkill(projectId, skillId, updates)

      // Update baseline so change detection stays correct
      setSkill((current) =>
        current?.id === skillId
          ? { ...current, ...updatedSkill, content: localContent.trim() }
          : current
      )

      // Sync local values to saved (trimmed/normalized) values so hasChanges becomes false
      // Without this, localDescription/localContent may have trailing whitespace that
      // doesn't match the trimmed baseline, causing buttons to stay visible after save
      setLocalName(normalizedName)
      setLocalDescription(localDescription.trim())
      setLocalContent(localContent.trim())

      // If the canonical name changed, update the URL so deep-link resolution stays valid
      if (updatedSkill.name !== previousName) {
        navigate({
          to: '/projects/$slug/skills/$skillName',
          params: { slug: projectSlug, skillName: updatedSkill.name },
          replace: true,
        })
      }

      setSaveStatus('saved')
      // Reset status after brief feedback display so buttons disappear
      if (saveStatusTimeoutRef.current) {
        clearTimeout(saveStatusTimeoutRef.current)
      }
      saveStatusTimeoutRef.current = setTimeout(() => setSaveStatus('idle'), 1500)
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        const message = getErrorMessage(err)
        log.error('Failed to save skill:', message)
        setSaveError(message)
        setSaveStatus('error')
      }
    }
  }, [skill, canSave, localName, localDescription, localContent, projectId, skillId, updateSkill, navigate, projectSlug])

  // Handle cancel - revert to saved values
  const handleCancel = useCallback(() => {
    if (!skill) return
    setLocalName(skill.name)
    setLocalDescription(skill.description)
    setLocalContent(skill.content)
    setTouchedFields(new Set())
    setSaveError(null)
    setSaveStatus('idle')
  }, [skill])

  // Handle field changes with touched tracking
  const handleNameChange = useCallback((value: string) => {
    setLocalName(value)
    setSaveError(null)  // Clear API error when user tries again
  }, [])

  const handleDescriptionChange = useCallback((value: string) => {
    setLocalDescription(value)
    setTouchedFields((prev) => new Set(prev).add('description'))
  }, [])

  const handleContentChange = useCallback((value: string) => {
    setLocalContent(value)
    setTouchedFields((prev) => new Set(prev).add('content'))
  }, [])

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">Loading skill...</p>
      </div>
    )
  }

  if (error || !skill) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="text-destructive mb-2">Failed to load skill</p>
          {error && <p className="text-sm text-muted-foreground">{error}</p>}
        </div>
      </div>
    )
  }

  // Combine mobile back button + document tree toggle for leading slot
  // Note: DocumentTreeToggle hidden on mobile (single screen layout)
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

  // Only render leading if there's content
  const hasLeadingContent = mobileBackButton || documentTreeCollapsed

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <DocumentHeaderBar
        leading={hasLeadingContent ? leadingContent : undefined}
        title={
          <span className="text-sm font-medium">
            /{localName}
          </span>
        }
        trailing={
          // Only show controls when user has made changes or there's a status to display
          (hasChanges || saveStatus !== 'idle') ? (
            <div className="flex items-center gap-2">
              {/* Status indicator */}
              {saveStatus === 'saving' && (
                <span className="text-sm text-muted-foreground">Saving...</span>
              )}
              {saveStatus === 'saved' && (
                <span className="text-sm text-success">Saved</span>
              )}
              {saveStatus === 'error' && (
                <span
                  className="text-sm text-destructive max-w-[200px] truncate"
                  title={saveError || undefined}
                >
                  {saveError || 'Failed'}
                </span>
              )}
              {/* Action buttons - only when there are unsaved changes */}
              {hasChanges && (
                <>
                  {!canSave && (
                    <span className="text-sm text-destructive">
                      {nameValidation.error ||
                       (isDescriptionEmpty ? 'Description required' : 'Instructions required')}
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCancel}
                    disabled={saveStatus === 'saving'}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleSave}
                    disabled={!canSave || saveStatus === 'saving'}
                  >
                    Save
                  </Button>
                </>
              )}
            </div>
          ) : undefined
        }
        ariaLabel="Skill editor"
        showDivider={false}
      />

      {/* Content area - uses shared SkillForm */}
      <div className="flex-1 overflow-hidden">
        <SkillForm
          name={localName}
          description={localDescription}
          content={localContent}
          onNameChange={handleNameChange}
          onDescriptionChange={handleDescriptionChange}
          onContentChange={handleContentChange}
          nameError={nameValidation.error || saveError || undefined}
          descriptionError={descriptionError}
          contentError={contentError}
          showNameHint={true}
          disabled={saveStatus === 'saving'}
        />
      </div>
    </div>
  )
}
