import { useState } from 'react'

/**
 * Generic hook for managing dialog state with optional associated data.
 * Replaces boilerplate for isOpen + item state management.
 *
 * @example
 * ```ts
 * const skillDialog = useDialogState<SkillWithContent>()
 * skillDialog.open(someSkill) // Open with data
 * skillDialog.close() // Close and clear data
 * <SkillDialog open={skillDialog.isOpen} skill={skillDialog.item} />
 * ```
 */
export function useDialogState<T = void>() {
  const [isOpen, setIsOpen] = useState(false)
  const [item, setItem] = useState<T | null>(null)

  const open = (data?: T) => {
    setItem((data ?? null) as T | null)
    setIsOpen(true)
  }

  const close = () => {
    setIsOpen(false)
    setItem(null)
  }

  return { isOpen, item, open, close }
}
