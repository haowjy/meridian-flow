import { cn } from '@/lib/utils'

interface ChatBreadcrumbProps {
  projectName?: string | null
  chatTitle?: string | null
}

/**
 * Compact breadcrumb for the chat header, showing Project / Chat title.
 */
export function ChatBreadcrumb({ projectName, chatTitle }: ChatBreadcrumbProps) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="truncate font-semibold text-muted-foreground">
        {projectName ?? 'Project'}
      </span>
      {chatTitle ? (
        <>
          <span aria-hidden="true" className="text-muted-foreground/70">
            /
          </span>
          <span className="truncate font-medium text-foreground" title={chatTitle}>
            {chatTitle}
          </span>
        </>
      ) : null}
    </div>
  )
}
