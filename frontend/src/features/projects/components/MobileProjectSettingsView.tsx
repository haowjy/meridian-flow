import { useState } from 'react'
import { MobilePanelHeader } from '@/shared/components/layout/headers'
import { MobileMenuSheet } from '@/shared/components/layout/MobileMenuSheet'
import { ProjectSettingsPanelContent } from './ProjectSettingsPanel'

interface MobileProjectSettingsViewProps {
  projectId: string
}

/**
 * Mobile wrapper for project settings.
 * Provides mobile-appropriate header (hamburger menu) and renders
 * the settings content without the desktop SidebarToggle.
 */
export function MobileProjectSettingsView({ projectId }: MobileProjectSettingsViewProps) {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="flex h-full flex-col">
      {/* Mobile header with hamburger */}
      <MobilePanelHeader
        title="Project Settings"
        onMenuOpen={() => setMenuOpen(true)}
      />

      <MobileMenuSheet open={menuOpen} onOpenChange={setMenuOpen} inWorkspace />

      {/* Settings content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <ProjectSettingsPanelContent projectId={projectId} />
      </div>
    </div>
  )
}
