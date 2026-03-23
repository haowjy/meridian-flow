import type { TextItem } from "../types"

type TextRowProps = {
  item: TextItem
}

export function TextRow({ item }: TextRowProps) {
  return (
    <div className="px-3 py-2">
      <p className="text-sm text-foreground">{item.text}</p>
    </div>
  )
}
