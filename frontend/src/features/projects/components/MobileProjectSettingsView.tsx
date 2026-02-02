import { useState } from 'react'
import { Menu } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { HeaderGradientFade } from '@/core/components/HeaderGradientFade'
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
      <div className="md:hidden flex items-center gap-2 px-3 h-14 bg-background shrink-0 relative">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
        >
          <Menu className="size-5" />
        </Button>
        <span className="font-medium text-sm">Project Settings</span>
        <HeaderGradientFade />
      </div>

      <MobileMenuSheet open={menuOpen} onOpenChange={setMenuOpen} inWorkspace />

      {/* Settings content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <ProjectSettingsPanelContent projectId={projectId} />
      </div>
    </div>
  )
}
