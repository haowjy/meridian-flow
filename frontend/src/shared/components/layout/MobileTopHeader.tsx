import { useState } from 'react'
import { MobileHeader } from './MobileHeader'
import { MobileMenuSheet } from './MobileMenuSheet'

interface MobileTopHeaderProps {
  projectName?: string
  inWorkspace?: boolean
}

/**
 * Standard mobile header used on projects list and other top-level pages.
 * Uses MobileHeader internally for consistent specs.
 */
export function MobileTopHeader({ projectName, inWorkspace = false }: MobileTopHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <>
      <MobileHeader
        title={projectName || (!inWorkspace ? 'Projects' : undefined)}
        onMenuOpen={() => setMenuOpen(true)}
      />

      <MobileMenuSheet open={menuOpen} onOpenChange={setMenuOpen} inWorkspace={inWorkspace} />
    </>
  )
}
