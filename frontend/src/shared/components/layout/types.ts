import type { ComponentType, ReactNode } from 'react'

/**
 * Panel definitions passed to layout strategies.
 * Content components are layout-agnostic - they don't know how they'll be arranged.
 */
export interface PanelDefinitions {
  /** Thread list panel (left in desktop three-panel, tab in mobile) */
  threadList: ReactNode
  /** Active thread panel (center in desktop, tab in mobile) */
  activeThread: ReactNode
  /** Document panel - tree or editor (right in desktop, tab in mobile) */
  documentPanel: ReactNode
  /** Project settings panel (left panel view option) */
  projectSettings?: ReactNode
}

/**
 * Props that layout strategies receive.
 * Strategies use these to implement their specific arrangement and controls.
 */
export interface LayoutStrategyProps {
  /** Panel content to render */
  panels: PanelDefinitions
  /** Additional className for root element */
  className?: string
  /** Left panel view state (chat, thread list, or project settings) - Phase 3 rail navigation */
  leftPanelView?: 'chat' | 'threads' | 'projectSettings'
}

/**
 * Layout strategy component type.
 * Each strategy implements its own panel arrangement (three-panel, tabs, drawer, etc.)
 */
export type LayoutStrategyComponent = ComponentType<LayoutStrategyProps>
