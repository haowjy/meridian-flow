# Inline Result Rendering

Renders Python execution results (charts, images, tables, code output, mesh references) in the chat activity stream. Extends v2's existing `ActivityBlock` rendering pipeline. See [overview](overview.md) for frontend architecture context.

## Architecture

Two rendering paths for Python execution data:

1. **PythonDetail** — tool detail component for `execute_python`, showing streaming output and the code that ran. Renders inside the collapsible ActivityBlock card when the tool is expanded.
2. **ResultRow** — always-visible rich result blocks (charts, tables, images, mesh refs). Render outside the collapsible card in the activity stream.

See [activity-stream-extensions.md](activity-stream-extensions.md) for how events flow through the reducer into these components.

## Component Architecture

```
features/activity-stream/
├── PythonDetail.tsx            # ToolDetail for execute_python
├── items/
│   └── ResultRow.tsx           # Rich result block renderer (routes to sub-renderers)
│
features/inline-results/
├── PlotlyBlock.tsx             # Interactive Plotly chart
├── PlotlyBlock.stories.tsx
├── ImageBlock.tsx              # Matplotlib PNG display
├── ImageBlock.stories.tsx
├── DataFrameBlock.tsx          # Styled HTML table
├── DataFrameBlock.stories.tsx
├── MeshRefBlock.tsx            # "View in 3D" card
├── MeshRefBlock.stories.tsx
├── PythonOutputBlock.tsx       # Streaming stdout/stderr
├── PythonOutputBlock.stories.tsx
└── types.ts                    # Shared result types
```

## PythonDetail

Shown inside `ToolDetail` routing when tool category is `"python"`. Renders the Python code and streaming output:

```tsx
// features/activity-stream/PythonDetail.tsx

import { DetailCard } from "./DetailCard"
import { PythonOutputBlock } from "@/features/inline-results/PythonOutputBlock"
import type { ToolItem } from "./types"

function PythonDetail({ tool }: { tool: ToolItem }) {
  // Extract code from tool args
  const code = tool.parsedArgs?.code as string | undefined

  return (
    <DetailCard className="space-y-0 p-0">
      {/* Code preview */}
      {code && (
        <div className="border-b">
          <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
            Python
          </div>
          <pre className="max-h-48 overflow-auto px-3 pb-3 font-mono text-xs text-foreground/80">
            {code}
          </pre>
        </div>
      )}

      {/* Streaming output */}
      {tool.pythonOutput && tool.pythonOutput.length > 0 && (
        <PythonOutputBlock
          lines={tool.pythonOutput}
          isStreaming={tool.status === "executing"}
        />
      )}

      {/* Tool result summary */}
      {tool.resultText && (
        <div className="border-t px-3 py-2 text-xs text-muted-foreground">
          {tool.isError ? (
            <span className="text-destructive">{tool.resultText}</span>
          ) : (
            tool.resultText
          )}
        </div>
      )}
    </DetailCard>
  )
}
```

## ResultRow

Routes `ResultItem` to the appropriate renderer. Renders in the activity stream between the tool card and the response text:

```tsx
// features/activity-stream/items/ResultRow.tsx

import type { ResultItem } from "../types"
import { PlotlyBlock } from "@/features/inline-results/PlotlyBlock"
import { ImageBlock } from "@/features/inline-results/ImageBlock"
import { DataFrameBlock } from "@/features/inline-results/DataFrameBlock"
import { MeshRefBlock } from "@/features/inline-results/MeshRefBlock"

function ResultRow({ item }: { item: ResultItem }) {
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

## PythonOutputBlock

Displays streaming stdout/stderr during execution:

```tsx
// features/inline-results/PythonOutputBlock.tsx

function PythonOutputBlock({ lines, isStreaming }: Props) {
  const [collapsed, setCollapsed] = useState(lines.length > 20)
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
        {visibleLines.map((line, i) => (
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

**Collapsible**: Auto-collapses when output exceeds 20 lines. Shows last 20 with "Show N earlier lines" toggle. Long output is common during DICOM processing (200+ slice notifications).

## PlotlyBlock

Renders interactive Plotly charts from JSON spec:

```tsx
// features/inline-results/PlotlyBlock.tsx

import { lazy, Suspense, useMemo } from "react"

// Lazy-load Plotly to avoid 1.2MB in initial bundle
const Plot = lazy(() => import("react-plotly.js"))

function PlotlyBlock({ plotlyJson }: { plotlyJson: object }) {
  const spec = useMemo(() => {
    // plotlyJson is already parsed (came from reducer, originally from JSON event)
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

**Lazy loading**: `react-plotly.js` + `plotly.js-dist-min` is ~1.2MB gzipped. Dynamic import keeps it out of the initial bundle. Shows "Loading chart..." placeholder during load.

**Theme**: Transparent background inherits from the design system. Font uses CSS variable for consistency.

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
          alt="Python output figure"
          className="h-auto max-h-[400px] max-w-full"
        />
      </button>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-h-[90vh] max-w-[90vw]">
          <img src={src} alt="Python output figure (expanded)" className="h-auto w-full" />
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

**Styling**: Table styles via a global CSS class. Add to `src/index.css`:

```css
.meridian-table-wrapper table {
  @apply w-full text-sm;
}
.meridian-table-wrapper th {
  @apply sticky top-0 border-b bg-muted/30 px-3 py-2 text-left font-medium;
}
.meridian-table-wrapper td {
  @apply border-b px-3 py-2 tabular-nums;
}
.meridian-table-wrapper tr:hover td {
  @apply bg-muted/20;
}
```

**Security**: `DOMPurify` (already in `package.json`) sanitizes the HTML with a strict allowlist. Only table-related tags are permitted, even though `df.to_html(escape=True)` should be safe. Defense in depth.

## MeshRefBlock

Shows a reference to 3D mesh data with a button to open the viewer:

```tsx
// features/inline-results/MeshRefBlock.tsx

import { Cube } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { useWorkspaceStore } from "@/stores/workspace-store"

function MeshRefBlock({ meshId, vertexCount, faceCount, labelNames }: Props) {
  const showViewer = useWorkspaceStore((s) => s.showViewer)

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
      <Button variant="outline" size="sm" onClick={() => showViewer(meshId)}>
        View 3D
      </Button>
    </div>
  )
}
```

Clicking "View 3D" calls `useWorkspaceStore.showViewer(meshId)` which switches the right panel to the 3D viewer. See [state.md](state.md) for store details.

## Dependencies

```
react-plotly.js           # React wrapper for Plotly (lazy loaded)
plotly.js-dist-min        # Plotly core (minified, ~1.2MB gzip)
```

Already in `package.json`:
- `dompurify` — HTML sanitization
- `@radix-ui/react-dialog` — image expand dialog

## Storybook Stories

Each block component has a co-located `.stories.tsx` file with:

- **PlotlyBlock**: Bar chart, scatter plot, box plot examples using sample biomedical data
- **ImageBlock**: Sample matplotlib figure (base64 PNG), click-to-expand interaction
- **DataFrameBlock**: Small table (5 rows), large table (50 rows with scroll), no-title variant
- **MeshRefBlock**: With label names, without label names, large vertex count formatting
- **PythonOutputBlock**: Short output, long output (auto-collapse), stderr highlighting, streaming cursor
- **ResultRow**: Each result type routed correctly

Stories use shared mock data from `features/inline-results/examples/mock-data.ts`.

## Related Docs

- [Activity Stream Extensions](activity-stream-extensions.md) — how events become ResultItems
- [3D Viewer](viewer-3d.md) — MeshRefBlock triggers viewer via workspace store
- [Stream Extensions (backend)](../backend/stream-extensions.md) — event payloads
