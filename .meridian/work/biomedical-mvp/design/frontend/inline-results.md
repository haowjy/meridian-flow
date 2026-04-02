# Inline Result Rendering

Renders display results (charts, images, tables, code output, mesh references) in the chat activity stream. Display results render outside the collapsed ActivityBlock card, always visible. See [overview](overview.md) for frontend architecture context.

**Revised from previous design**: Driven by generic `DISPLAY_RESULT` events instead of Python-specific `PYTHON_RESULT`. Components are the same; the data pipeline is generic.

## Architecture

Two rendering paths:

1. **ToolOutputBlock** — streaming stdout/stderr for tools that use OutputSink. Renders inside the collapsible ActivityBlock card when the tool is expanded (in BashDetail or any future tool detail).
2. **DisplayResultRow** — always-visible rich result blocks (charts, tables, images, mesh refs). Render outside the collapsible card in the activity stream.

See [activity-stream.md](activity-stream.md) for how events flow through the reducer into these components.

## Component Architecture

```
features/activity-stream/
├── items/
│   └── DisplayResultRow.tsx       # Rich result block renderer (routes to sub-renderers)
│
features/inline-results/
├── PlotlyBlock.tsx                # Interactive Plotly chart
├── PlotlyBlock.stories.tsx
├── ImageBlock.tsx                 # Matplotlib PNG display
├── ImageBlock.stories.tsx
├── DataFrameBlock.tsx             # Styled HTML table
├── DataFrameBlock.stories.tsx
├── MeshRefBlock.tsx               # "View in 3D" card
├── MeshRefBlock.stories.tsx
├── ToolOutputBlock.tsx            # Streaming stdout/stderr
├── ToolOutputBlock.stories.tsx
└── types.ts                       # Shared result types
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
          labelNames={item.data.label_names}
        />
      )
  }
}
```

## ToolOutputBlock

Displays streaming stdout/stderr during execution. Used inside BashDetail (and any future tool detail that supports streaming output):

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
            className={cn(
              "whitespace-pre-wrap",
              line.stream === "stderr" && "text-destructive"
            )}
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

Auto-collapses at 20 lines. Uses ref to avoid re-collapsing after manual expand.

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

Table styles via global CSS class in `src/index.css`:

```css
.meridian-table-wrapper table { @apply w-full text-sm; }
.meridian-table-wrapper th { @apply sticky top-0 border-b bg-muted/30 px-3 py-2 text-left font-medium; }
.meridian-table-wrapper td { @apply border-b px-3 py-2 tabular-nums; }
.meridian-table-wrapper tr:hover td { @apply bg-muted/20; }
```

## MeshRefBlock

Shows a reference to 3D mesh data with a button to open the viewer:

```tsx
// features/inline-results/MeshRefBlock.tsx

import { Cube } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { useWorkspaceStore } from "@/stores/workspace-store"

function MeshRefBlock({ meshId, vertexCount, faceCount, labelNames }: Props) {
  const showViewer = useWorkspaceStore((s) => s.showViewer)
  const hasMeshData = useViewerStore((s) => s.activeMeshId === meshId || s.meshData?.meshId === meshId)

  return (
    <div className="my-2 flex items-center gap-3 rounded-lg border p-3">
      <Cube className="h-8 w-8 text-accent-fill" />
      <div className="flex-1">
        <p className="text-sm font-medium">3D Model Generated</p>
        <p className="text-xs text-muted-foreground">
          {vertexCount.toLocaleString()} vertices, {faceCount.toLocaleString()} faces
          {labelNames && ` — ${Object.values(labelNames).join(", ")}`}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => showViewer(meshId)}
        disabled={!hasMeshData}
        title={hasMeshData ? "Open 3D viewer" : "3D data not loaded — re-run segmentation"}
      >
        View 3D
      </Button>
    </div>
  )
}
```

## Dependencies

```
react-plotly.js           # React wrapper for Plotly (lazy loaded)
plotly.js-dist-min        # Plotly core (minified, ~1.2MB gzip)
```

Already in `package.json`:
- `dompurify` — HTML sanitization
- `@radix-ui/react-dialog` — image expand dialog

## Storybook Stories

Each block component has a co-located `.stories.tsx` file. Stories use shared mock data from `features/inline-results/examples/mock-data.ts`.

## Related Docs

- [Activity Stream](activity-stream.md) — how events become DisplayResultItems
- [3D Viewer](viewer-3d.md) — MeshRefBlock triggers viewer via workspace store
- [Display Result Pipeline (backend)](../backend/display-results.md) — event payloads
