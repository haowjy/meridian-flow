import { createFileRoute, Outlet } from '@tanstack/react-router'
import { useProjectStore } from '@/core/stores/useProjectStore'
import { useEffect } from 'react'

export const Route = createFileRoute('/_authenticated/projects')({
  component: ProjectsLayout,
})

function ProjectsLayout() {
  const loadProjects = useProjectStore(s => s.loadProjects)

  // Load projects once when entering any /projects/* route
  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  return <Outlet />
}
