# Inline Result Rendering

Renders display results (charts, images, tables, code output, mesh references) inline in the visible zone of the ActivityBlock. Results are content — they appear interleaved with text, not in a separate area. See [overview](overview.md) for frontend architecture context.

**Key principle**: Images, charts, tables, and mesh cards are content, like text. They render in the visible zone alongside text in the order they arrive. The researcher sees a natural flow: text → chart → text → table → mesh card.

## Architecture

Two rendering paths:

1. **ToolOutputBlock** — streaming stdout/stderr. For tools with `stdout: "visible"` config (like python), this renders in the visible zone. For tools with `stdout: "collapsed"` config (like bash), it renders inside the collapsed zone's tool detail.
2. **DisplayResultRow** — always in the visible zone. Charts, images, tables, mesh cards rendered inline with text.

See [activity-stream.md](activity-stream.md) for the two-zone model and per-tool display config.

## Component Architecture

```
features/activity-stream/
+-- items/
|   +-- DisplayResultRow.tsx       # Routes to sub-renderers

features/inline-results/
+-- PlotlyBlock.tsx                # Interactive Plotly chart
+-- PlotlyBlock.stories.tsx
+-- ImageBlock.tsx                 # Matplotlib PNG display
+-- ImageBlock.stories.tsx
+-- DataFrameBlock.tsx             # Styled HTML table
+-- DataFrameBlock.stories.tsx
+-- MeshRefBlock.tsx               # "View in 3D" card (per mesh)
+-- MeshRefBlock.stories.tsx
+-- ToolOutputBlock.tsx            # Streaming stdout/stderr
+-- ToolOutputBlock.stories.tsx
+-- StderrPopover.tsx              # Click-to-view stderr popup
+-- types.ts                       # Shared result types
```

## DisplayResultRow

Routes `DisplayResultItem` to the appropriate renderer:

```tsx
// features/activity-stream/items/DisplayResultRow.tsx

import type { DisplayResultItem } from "../types"
import { PlotlyBlock } from "@/features/inline-results/PlotlyBlock"
import { ImageBlock } from "@/features/inline-results/ImageBlock"
import { DataFrameBlock } from "@/features/inline-results/DataFrameBlock"
import { MeshRefBlock } from "@/features/inline-results/MeshRefBlock"

function DisplayResultRow({ item }: { item: DisplayResultItem }) {
  switch (item.data.resultType) {
    case "plotly":
      return <PlotlyBlock plotlyJson={item.data.plotly_json} />
    case "image":
      return <ImageBlock base64={item.data.base64} format={item.data.format} />
    case "dataframe":
      return (
        <DataFrameBlock
          html={item.data.html}
          title={item.data.title}
          rowCount={item.data.row_count}
          colCount={item.data.col_count}
        />
      )
    case "mesh_ref":
      return (
        <MeshRefBlock
          meshId={item.data.mesh_id}
          vertexCount={item.data.vertex_count}
          faceCount={item.data.face_count}
          label={item.data.label}
          color={item.data.color}
        />
      )
  }
}
```

## ToolOutputBlock

Displays streaming stdout during execution. Used in the visible zone for python tool (config: `stdout: "visible"`) and inside BashDetail for bash tool (config: `stdout: "collapsed"`):

```tsx
// features/inline-results/ToolOutputBlock.tsx

function ToolOutputBlock({ lines, isStreaming }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const autoCollapsedRef = useRef(false)

  if (lines.length > 20 && !autoCollapsedRef.current) {
    autoCollapsedRef.current = true
    setCollapsed(true)
  }

  const visibleLines = collapsed ? lines.slice(-20) : lines

  return (
    <div className="font-mono text-xs">
      {collapsed && (
        <button
          className="w-full px-3 py-1 text-center text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setCollapsed(false)}
        >
          Show {lines.length - 20} earlier lines
        </button>
      )}

      <div className="max-h-[300px] overflow-y-auto px-3 py-2">
        {visibleLines.map((line) => (
          <div
            key={line.sequence}
            className="whitespace-pre-wrap"
          >
            {line.text}
          </div>
        ))}
        {isStreaming && <span className="animate-pulse">|</span>}
      </div>
    </div>
  )
}
```

Auto-collapses at 20 lines. Uses ref to avoid re-collapsing after manual expand. Only renders stdout lines — stderr is handled by the [StderrPopover](activity-stream.md#stderrpopover).

## PlotlyBlock

Renders interactive Plotly charts from JSON spec:

```tsx
// features/inline-results/PlotlyBlock.tsx

import { lazy, Suspense, useMemo } from "react"

const Plot = lazy(() => import("react-plotly.js"))

function PlotlyBlock({ plotlyJson }: { plotlyJson: object }) {
  const spec = useMemo(() => {
    return plotlyJson as { data: object[]; layout?: object }
  }, [plotlyJson])

  return (
    <div className="my-2 overflow-hidden rounded-lg border">
      <Suspense
        fallback={
          <div className="flex h-[400px] items-center justify-center text-sm text-muted-foreground">
            Loading chart...
          </div>
        }
      >
        <Plot
          data={spec.data}
          layout={{
            ...spec.layout,
            autosize: true,
            margin: { l: 50, r: 20, t: 40, b: 50 },
            paper_bgcolor: "transparent",
            plot_bgcolor: "transparent",
            font: { family: "var(--font-ui)" },
          }}
          config={{
            responsive: true,
            displayModeBar: true,
            modeBarButtonsToRemove: ["lasso2d", "select2d"],
          }}
          useResizeHandler
          className="w-full"
          style={{ height: 400 }}
        />
      </Suspense>
    </div>
  )
}
```

Lazy loading keeps ~1.2MB plotly bundle out of initial load.

## ImageBlock

Renders matplotlib output (base64 PNG) with click-to-expand:

```tsx
// features/inline-results/ImageBlock.tsx

import { Dialog, DialogContent } from "@/components/ui/dialog"

function ImageBlock({ base64, format }: { base64: string; format: string }) {
  const [expanded, setExpanded] = useState(false)
  const src = `data:image/${format};base64,${base64}`

  return (
    <>
      <button
        className="my-2 cursor-zoom-in overflow-hidden rounded-lg border transition hover:opacity-90"
        onClick={() => setExpanded(true)}
      >
        <img
          src={src}
          alt="Generated figure"
          className="h-auto max-h-[400px] max-w-full"
        />
      </button>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-h-[90vh] max-w-[90vw]">
          <img src={src} alt="Generated figure (expanded)" className="h-auto w-full" />
        </DialogContent>
      </Dialog>
    </>
  )
}
```

## DataFrameBlock

Renders pandas DataFrame as a styled, sanitized HTML table:

```tsx
// features/inline-results/DataFrameBlock.tsx

import DOMPurify from "dompurify"

function DataFrameBlock({ html, title, rowCount, colCount }: Props) {
  const sanitizedHtml = useMemo(
    () =>
      DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ["table", "thead", "tbody", "tr", "th", "td", "caption"],
        ALLOWED_ATTR: ["class", "colspan", "rowspan"],
      }),
    [html]
  )

  return (
    <div className="my-2 overflow-hidden rounded-lg border">
      {title && (
        <div className="border-b bg-muted/50 px-3 py-2 text-sm font-medium">
          {title}
          <span className="ml-2 text-muted-foreground">
            {rowCount} rows x {colCount} columns
          </span>
        </div>
      )}
      <div className="max-h-[400px] overflow-x-auto overflow-y-auto">
        <div
          className="meridian-table-wrapper"
          dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
        />
      </div>
    </div>
  )
}
```

## MeshRefBlock

Shows a reference to a single named mesh with a button to open the viewer. Multiple MeshRefBlocks appear for multi-mesh scenes — one per `show_mesh()` call.

```tsx
// features/inline-results/MeshRefBlock.tsx

import { Cube } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { useWorkspaceStore } from "@/stores/workspace-store"
import { useViewerStore } from "@/stores/viewer-store"

function MeshRefBlock({ meshId, vertexCount, faceCount, label, color }: Props) {
  const showViewer = useWorkspaceStore((s) => s.showViewer)
  const hasMeshData = useViewerStore((s) => s.meshes[meshId] !== undefined)

  return (
    <div className="my-2 flex items-center gap-3 rounded-lg border p-3">
      <div
        className="flex h-8 w-8 items-center justify-center rounded"
        style={{ backgroundColor: color + "20" }}
      >
        <Cube className="h-5 w-5" style={{ color }} />
      </div>
      <div className="flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">
          {vertexCount.toLocaleString()} vertices, {faceCount.toLocaleString()} faces
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => showViewer(meshId)}
        disabled={!hasMeshData}
        title={hasMeshData ? "Open 3D viewer" : "3D data not loaded -- re-run segmentation"}
      >
        View 3D
      </Button>
    </div>
  )
}
```

**Change from previous design**: Each MeshRefBlock shows one mesh with its own label and color. Multiple blocks appear for multi-mesh scenes. The "View 3D" button opens the viewer focused on this mesh (all scene meshes visible).

## Dependencies

```
react-plotly.js           # React wrapper for Plotly (lazy loaded)
plotly.js-dist-min        # Plotly core (minified, ~1.2MB gzip)
```

Already in `package.json`:
- `dompurify` — HTML sanitization
- `@radix-ui/react-dialog` — image expand dialog
- `@radix-ui/react-popover` — stderr popup

## Storybook Stories

Each block component has a co-located `.stories.tsx` file. Stories use shared mock data from `features/inline-results/examples/mock-data.ts`.

## Related Docs

- [Activity Stream](activity-stream.md) — two-zone model and per-tool display config
- [3D Viewer](viewer-3d.md) — MeshRefBlock triggers viewer via workspace store
- [Display Result Pipeline (backend)](../backend/display-results.md) — event payloads
