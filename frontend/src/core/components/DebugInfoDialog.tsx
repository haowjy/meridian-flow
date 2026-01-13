import { useState } from 'react'
import { ChevronDown, ChevronRight, Copy, Check } from 'lucide-react'
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
  const [jsonOpen, setJsonOpen] = useState(false)

  const formatNumber = (n: number | null | undefined) => {
    if (n == null) return '—'
    return n.toLocaleString()
  }

  const totalTokens = (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0)

  // Serialize turn to JSON with Date handling
  const turnJson = JSON.stringify(
    turn,
    (_, value) => (value instanceof Date ? value.toISOString() : value),
    2
  )

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="w-[80vw] max-w-[80vw] sm:max-w-none max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">
            Turn Debug: {turn.role}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5 text-sm">
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
            {turn.responseMetadata?.upstream_provider && (
              <Row
                label="Upstream"
                value={String(turn.responseMetadata.upstream_provider)}
                mono
              />
            )}
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
              <div className="mt-2 space-y-3">
                {turn.blocks.map((block, index) => (
                  <BlockItem key={block.id} block={block} index={index} />
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Full JSON (collapsible) */}
          <Collapsible open={jsonOpen} onOpenChange={setJsonOpen}>
            <div className="flex items-center gap-2">
              <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
                {jsonOpen ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <ChevronRight className="w-3 h-3" />
                )}
                Full JSON
              </CollapsibleTrigger>
              <CopyButton text={turnJson} />
            </div>
            <CollapsibleContent>
              <pre className="mt-2 p-3 bg-muted/50 rounded border border-border text-xs font-mono whitespace-pre-wrap break-all overflow-x-auto max-h-[400px] overflow-y-auto select-text">
                {turnJson}
              </pre>
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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea')
      textarea.value = text
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <button
      onClick={handleCopy}
      className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
      title="Copy to clipboard"
    >
      {copied ? (
        <Check className="w-3 h-3 text-green-500" />
      ) : (
        <Copy className="w-3 h-3" />
      )}
    </button>
  )
}

function BlockItem({ block, index }: { block: TurnBlock; index: number }) {
  const [expanded, setExpanded] = useState(false)
  const [metadataOpen, setMetadataOpen] = useState(false)

  const fullContent = (() => {
    if (block.textContent) return block.textContent
    if (block.content) return JSON.stringify(block.content, null, 2)
    return '—'
  })()

  const contentPreview = fullContent.length > 150
    ? fullContent.slice(0, 150) + '...'
    : fullContent

  return (
    <div className="border border-border rounded p-3 text-xs">
      {/* Block header - type info only */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-muted-foreground font-medium">#{index + 1}</span>
        <span className="font-semibold text-foreground">{block.blockType}</span>
        {block.status === 'partial' && (
          <span className="text-amber-500 text-[10px] px-1.5 py-0.5 bg-amber-500/10 rounded">
            partial
          </span>
        )}
      </div>

      {/* Block metadata (collapsible) */}
      <Collapsible open={metadataOpen} onOpenChange={setMetadataOpen}>
        <CollapsibleTrigger className="text-[10px] text-muted-foreground hover:text-foreground transition-colors mb-2 flex items-center gap-1">
          {metadataOpen ? (
            <ChevronDown className="w-2.5 h-2.5" />
          ) : (
            <ChevronRight className="w-2.5 h-2.5" />
          )}
          Metadata
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] mb-2 p-2 bg-muted/30 rounded">
            <div>
              <span className="text-muted-foreground">ID: </span>
              <span className="font-mono">{block.id}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Turn ID: </span>
              <span className="font-mono">{block.turnId}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Sequence: </span>
              <span className="font-mono">{block.sequence}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Status: </span>
              <span className="font-mono">{block.status ?? 'complete'}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Created: </span>
              <span className="font-mono">{block.createdAt.toISOString()}</span>
            </div>
            {block.updatedAt && (
              <div>
                <span className="text-muted-foreground">Updated: </span>
                <span className="font-mono">{block.updatedAt.toISOString()}</span>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Content section - matching Metadata style */}
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <div className="flex items-center gap-1 mb-1">
          <CollapsibleTrigger className="text-[10px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1">
            {expanded ? (
              <ChevronDown className="w-2.5 h-2.5" />
            ) : (
              <ChevronRight className="w-2.5 h-2.5" />
            )}
            Content
          </CollapsibleTrigger>
          <CopyButton text={fullContent} />
        </div>
        {/* Always show preview when collapsed */}
        {!expanded && (
          <pre className="text-muted-foreground whitespace-pre-wrap break-all font-mono bg-muted/50 rounded p-2 select-text overflow-x-auto">
            {contentPreview}
          </pre>
        )}
        <CollapsibleContent>
          <pre className="text-muted-foreground whitespace-pre-wrap break-all font-mono bg-muted/50 rounded p-2 select-text overflow-x-auto max-h-[300px] overflow-y-auto">
            {fullContent}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
