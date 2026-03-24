import type { ReactNode } from "react"

import { Separator } from "@/components/ui/separator"

import { DetailCard } from "./DetailCard"
import type { DocSearchToolDetail } from "./types"

type DocSearchDetailProps = {
  detail: DocSearchToolDetail
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function highlightSnippet(snippet: string, query: string) {
  const terms = query
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)

  if (terms.length === 0) {
    return snippet
  }

  const expression = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi")
  const output: ReactNode[] = []
  let lastIndex = 0
  let matchIndex = 0

  for (const match of snippet.matchAll(expression)) {
    const matchText = match[0]
    const start = match.index ?? 0
    const end = start + matchText.length

    if (start > lastIndex) {
      output.push(<span key={`text-${matchIndex}`}>{snippet.slice(lastIndex, start)}</span>)
    }

    output.push(
      <mark key={`mark-${matchIndex}`} className="rounded bg-accent-fill/15 px-0.5 text-foreground">
        {matchText}
      </mark>
    )
    lastIndex = end
    matchIndex += 1
  }

  if (lastIndex < snippet.length) {
    output.push(<span key="tail">{snippet.slice(lastIndex)}</span>)
  }

  return output
}

export function DocSearchDetail({ detail }: DocSearchDetailProps) {
  return (
    <DetailCard className="[&>div]:space-y-2 [&>div]:p-3">
      {detail.matches.length === 0 ? (
        <p className="text-sm text-muted-foreground">No matches found in the manuscript.</p>
      ) : (
        <div className="space-y-2">
          {detail.matches.map((match, index) => (
            <div key={match.id} className="space-y-1">
              {index > 0 ? <Separator /> : null}
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <p className="font-medium text-foreground">{match.filePath}</p>
                <p className="text-muted-foreground">
                  Lines {match.lineStart}
                  {typeof match.lineEnd === "number" ? `-${match.lineEnd}` : null}
                </p>
              </div>
              <p className="font-editor text-sm italic text-muted-foreground">
                {highlightSnippet(match.snippet, detail.query)}
              </p>
            </div>
          ))}
        </div>
      )}
    </DetailCard>
  )
}
