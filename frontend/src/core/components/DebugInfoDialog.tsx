import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/shared/components/ui/collapsible'
import type { Turn, TurnBlock } from '@/features/threads/types'

interface TurnDebugDialogProps {
  isOpen: boolean
  onClose: () => void
  turn: Turn
}

/**
 * Debug dialog for turn inspection.
 *
 * Shows turn metadata, token details, and block breakdown.
 * Only shown when VITE_DEV_TOOLS=1.
 */
export function TurnDebugDialog({ isOpen, onClose, turn }: TurnDebugDialogProps) {
  const [blocksOpen, setBlocksOpen] = useState(false)

  const formatNumber = (n: number | null | undefined) => {
    if (n == null) return '—'
    return n.toLocaleString()
  }

  const totalTokens = (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0)

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">
            Turn Debug: {turn.role}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {/* Turn Metadata */}
          <Section title="Metadata">
            <Row label="ID" value={turn.id} mono />
            <Row label="Thread ID" value={turn.threadId} mono />
            <Row label="Prev Turn ID" value={turn.prevTurnId ?? '—'} mono />
            <Row label="Role" value={turn.role} />
            <Row label="Status" value={turn.status} />
            {turn.error && <Row label="Error" value={turn.error} />}
            <Row label="Created" value={turn.createdAt.toISOString()} mono />
            {turn.completedAt && (
              <Row label="Completed" value={turn.completedAt.toISOString()} mono />
            )}
            {turn.siblingIds.length > 0 && (
              <Row label="Siblings" value={turn.siblingIds.length.toString()} />
            )}
          </Section>

          {/* Token Details */}
          <Section title="Tokens">
            <Row label="Model" value={turn.model ?? '—'} />
            <Row label="Input" value={formatNumber(turn.inputTokens)} mono />
            <Row label="Output" value={formatNumber(turn.outputTokens)} mono />
            <Row label="Total" value={formatNumber(totalTokens)} mono />
          </Section>

          {/* Blocks (collapsible) */}
          <Collapsible open={blocksOpen} onOpenChange={setBlocksOpen}>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
              {blocksOpen ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              Blocks ({turn.blocks.length})
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 space-y-2">
                {turn.blocks.map((block, index) => (
                  <BlockItem key={block.id} block={block} index={index} />
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-medium text-muted-foreground mb-2">{title}</h3>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground min-w-[100px]">{label}:</span>
      <span className={mono ? 'font-mono text-xs' : ''}>{value}</span>
    </div>
  )
}

function BlockItem({ block, index }: { block: TurnBlock; index: number }) {
  const [expanded, setExpanded] = useState(false)

  // Get content preview
  const getContentPreview = () => {
    if (block.textContent) {
      return block.textContent.length > 100
        ? block.textContent.slice(0, 100) + '...'
        : block.textContent
    }
    if (block.content) {
      const json = JSON.stringify(block.content)
      return json.length > 100 ? json.slice(0, 100) + '...' : json
    }
    return '—'
  }

  const getFullContent = () => {
    if (block.textContent) return block.textContent
    if (block.content) return JSON.stringify(block.content, null, 2)
    return '—'
  }

  const hasExpandableContent =
    (block.textContent && block.textContent.length > 100) ||
    (block.content && JSON.stringify(block.content).length > 100)

  return (
    <div className="border border-border rounded p-2 text-xs">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-muted-foreground">#{index + 1}</span>
        <span className="font-medium">{block.blockType}</span>
        <span className="font-mono text-muted-foreground text-[10px]">
          {block.id}
        </span>
        {block.status === 'partial' && (
          <span className="text-orange-500 text-[10px]">partial</span>
        )}
      </div>

      {hasExpandableContent ? (
        <Collapsible open={expanded} onOpenChange={setExpanded}>
          <CollapsibleTrigger className="text-left w-full">
            <div className="text-muted-foreground whitespace-pre-wrap font-mono bg-muted/50 rounded p-1.5 hover:bg-muted transition-colors">
              {expanded ? getFullContent() : getContentPreview()}
            </div>
          </CollapsibleTrigger>
        </Collapsible>
      ) : (
        <div className="text-muted-foreground whitespace-pre-wrap font-mono bg-muted/50 rounded p-1.5">
          {getContentPreview()}
        </div>
      )}
    </div>
  )
}
