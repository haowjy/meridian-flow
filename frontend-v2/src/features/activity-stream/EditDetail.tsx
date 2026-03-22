import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

import type { EditReviewStatus, EditToolDetail } from "./types"

type EditDetailProps = {
  detail: EditToolDetail
}

function getReviewBorder(status: EditReviewStatus) {
  if (status === "accepted") {
    return "border-l-success"
  }

  if (status === "rejected") {
    return "border-l-destructive"
  }

  return "border-l-muted-foreground"
}

export function EditDetail({ detail }: EditDetailProps) {
  const reviewStatus = detail.reviewStatus ?? "pending-review"

  return (
    <Card
      className={cn(
        "border-border/70 border-l-[3px] bg-card/90",
        getReviewBorder(reviewStatus)
      )}
    >
      <CardContent className="space-y-3 p-3">
        <p className="text-xs text-muted-foreground">
          +{detail.addedLines ?? 0} lines, -{detail.removedLines ?? 0} lines, {detail.hunks ?? 0} hunks
        </p>

        <div className="max-h-52 overflow-auto rounded-md border border-border/60 bg-background/80 p-2 font-mono text-xs">
          {detail.diffLines.map((line, index) => (
            <p
              key={`${detail.filePath}-diff-${index}`}
              className={cn(
                "whitespace-pre-wrap px-1 py-0.5",
                line.type === "add" ? "bg-success/10 text-success" : undefined,
                line.type === "remove" ? "bg-destructive/10 text-destructive" : undefined,
                line.type === "context" ? "text-muted-foreground" : undefined
              )}
            >
              {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "} {line.text}
            </p>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="h-8 bg-success px-3 text-xs text-success-foreground hover:bg-success/90"
            onClick={detail.onAccept}
          >
            Accept
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 border-destructive px-3 text-xs text-destructive hover:bg-destructive/10"
            onClick={detail.onReject}
          >
            Reject
          </Button>
          <Button size="sm" variant="ghost" className="h-8 px-3 text-xs" onClick={detail.onReviewInEditor}>
            Review in Editor
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
