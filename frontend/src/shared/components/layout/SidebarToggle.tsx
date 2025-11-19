"use client"

import { PanelLeft, PanelRight, SidebarClose, SidebarOpen } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { useUIStore } from '@/core/stores/useUIStore'
import { useShallow } from 'zustand/react/shallow'
import { cn } from '@/lib/utils'

interface SidebarToggleProps {
    side: 'left' | 'right'
    className?: string
}

/**
 * Standardized sidebar toggle button.
 * Handles interaction with UI store and renders appropriate icon.
 */
export function SidebarToggle({ side, className }: SidebarToggleProps) {
    const {
        isCollapsed,
        toggle
    } = useUIStore(useShallow((s) => ({
        isCollapsed: side === 'left' ? s.leftPanelCollapsed : s.rightPanelCollapsed,
        toggle: side === 'left' ? s.toggleLeftPanel : s.toggleRightPanel,
    })))

    const label = isCollapsed ? `Expand ${side} sidebar` : `Collapse ${side} sidebar`

    // Icon logic:
    // If collapsed, we want to show an icon that implies "Open" (PanelLeft/Right).
    // If open, we want to show an icon that implies "Close" (SidebarClose/Open or similar).
    //
    // Standard convention:
    // Left Open (Collapsed -> Expanded): PanelLeft (or SidebarOpen)
    // Left Close (Expanded -> Collapsed): PanelLeft (or SidebarClose)
    //
    // Let's use the Lucide `PanelLeft` / `PanelRight` which usually depict the sidebar itself.
    // When collapsed, showing the icon usually means "click to show this panel".
    // When expanded, showing the icon usually means "click to hide this panel".
    //
    // To make it very clear, let's stick to `PanelLeft` / `PanelRight` for now as they are standard.
    // If we want specific "Close" icons, `SidebarClose` is good.
    //
    // Let's try:
    // Left Side:
    //   Collapsed: PanelLeft (Show Left Panel)
    //   Expanded: PanelLeft (Hide Left Panel) - or SidebarClose?
    //   Actually, `PanelLeft` is often used for both toggle states.
    //   Let's use `PanelLeft` for left and `PanelRight` for right for consistency with previous design,
    //   BUT user complained about "chevrons floating".
    //   The plan mentioned `PanelLeft`/`PanelRight` or `SidebarClose`.
    //   Let's use `PanelLeft` for Left and `PanelRight` for Right. They are distinct enough.

    const Icon = side === 'left' ? PanelLeft : PanelRight

    return (
        <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            className={cn("size-8", className)}
            aria-label={label}
            title={label}
        >
            <Icon className="size-4.5" />
        </Button>
    )
}
