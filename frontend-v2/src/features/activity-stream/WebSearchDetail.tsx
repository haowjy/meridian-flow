import { ArrowSquareOut, Globe } from "@phosphor-icons/react"

import { Card, CardContent } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

import type { WebSearchToolDetail } from "./types"

type WebSearchDetailProps = {
  detail: WebSearchToolDetail
}

function getDomain(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

export function WebSearchDetail({ detail }: WebSearchDetailProps) {
  return (
    <Card variant="outline" className="border-border/70">
      <CardContent className="space-y-2 p-3">
        {detail.results.length === 0 ? (
          <p className="text-sm text-muted-foreground">No results found.</p>
        ) : (
          <div className="space-y-2">
            {detail.results.map((result, index) => (
              <div key={result.id} className="space-y-1">
                {index > 0 ? <Separator /> : null}
                <div className="flex items-start justify-between gap-2">
                  <a
                    href={result.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground hover:text-accent-text"
                  >
                    {result.title}
                    <ArrowSquareOut className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
                  </a>
                </div>
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Globe className="size-3 shrink-0" aria-hidden="true" />
                  {getDomain(result.url)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {result.snippet}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
