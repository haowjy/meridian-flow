import type { TurnBlock, UserTurn } from "../types"

function getString(content: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = content?.[key]
  return typeof value === "string" ? value : undefined
}

function UserBlock({ block }: { block: TurnBlock }) {
  const content = block.content

  if (block.blockType === "text" || block.blockType === "thinking") {
    if (!block.textContent) {
      return null
    }

    return <p className="whitespace-pre-wrap leading-relaxed text-card-foreground">{block.textContent}</p>
  }

  if (block.blockType === "image") {
    const imageUrl = getString(content, "url")
    if (!imageUrl) {
      return null
    }

    const altText = getString(content, "alt_text") ?? "User attached image"

    return (
      <figure className="space-y-2">
        <img
          src={imageUrl}
          alt={altText}
          className="max-h-72 w-full rounded-lg border border-border/70 object-cover"
          loading="lazy"
        />
        {block.textContent ? (
          <figcaption className="text-xs text-muted-foreground">{block.textContent}</figcaption>
        ) : null}
      </figure>
    )
  }

  if (block.blockType === "reference" || block.blockType === "partial_reference") {
    const title = getString(content, "title") ?? getString(content, "ref_id") ?? "Reference"
    const refType = getString(content, "ref_type")

    return (
      <div className="rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-sm">
        <p className="font-medium text-foreground">{title}</p>
        {refType ? <p className="text-xs text-muted-foreground">{refType}</p> : null}
      </div>
    )
  }

  if (block.textContent) {
    return <p className="whitespace-pre-wrap leading-relaxed text-card-foreground">{block.textContent}</p>
  }

  if (content) {
    return (
      <pre className="overflow-x-auto rounded-lg bg-background/70 p-2 text-xs text-muted-foreground">
        {JSON.stringify(content, null, 2)}
      </pre>
    )
  }

  return null
}

export function UserBubble({ turn }: { turn: UserTurn }) {
  return (
    <div className="flex justify-end">
      <article className="max-w-[80%] space-y-3 rounded-xl border border-border/80 bg-card px-4 py-3 text-sm shadow-sm">
        {turn.blocks.map((block) => (
          <UserBlock key={block.id} block={block} />
        ))}
      </article>
    </div>
  )
}
