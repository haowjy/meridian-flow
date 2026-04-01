# Inline Result Rendering

Renders Python execution results (charts, images, tables, code output) directly in chat turn blocks. Extends the existing `ActivityBlock` rendering pipeline. See [overview](../overview.md) for system context.

## New Block Renderers

The existing `ActivityBlock` renders turn blocks by type (text, thinking, tool_use, tool_result, etc.). We add new renderers for Python output:

```
features/threads/components/blocks/
├── TextBlock.tsx             # Existing
├── ToolDetail.tsx            # Existing
├── PythonOutputBlock.tsx     # NEW: stdout/stderr display
├── PlotlyBlock.tsx           # NEW: interactive Plotly chart
├── ImageBlock.tsx            # NEW: matplotlib PNG image
├── DataFrameBlock.tsx        # NEW: HTML table
├── MeshRefBlock.tsx          # NEW: "View in 3D" link/thumbnail
```

## Block Type Mapping

| `resultType` | Block Component | Behavior |
|--------------|-----------------|----------|
| stdout/stderr | `PythonOutputBlock` | Monospace text, auto-scroll, collapsible |
| `plotly` | `PlotlyBlock` | Interactive chart with Plotly.js |
| `image` | `ImageBlock` | PNG/JPEG display, click to expand |
| `dataframe` | `DataFrameBlock` | Styled HTML table, sortable columns |
| `mesh_ref` | `MeshRefBlock` | Thumbnail + "Open 3D Viewer" button |

## PythonOutputBlock

Displays streaming stdout/stderr during execution:

```tsx
// features/threads/components/blocks/PythonOutputBlock.tsx

function PythonOutputBlock({ lines, isStreaming }: Props) {
  return (
    <div className="font-mono text-sm bg-muted/50 rounded-lg p-3 max-h-[300px] overflow-y-auto">
      {lines.map((line, i) => (
        <div key={i} className={cn(
          "whitespace-pre-wrap",
          line.stream === 'stderr' && "text-destructive"
        )}>
          {line.text}
        </div>
      ))}
      {isStreaming && <span className="animate-pulse">|</span>}
    </div>
  )
}
```

**Collapsible**: When output exceeds 20 lines, collapse with "Show N more lines" toggle. Long output is common during DICOM processing.

## PlotlyBlock

Renders interactive Plotly charts from JSON spec:

```tsx
// features/threads/components/blocks/PlotlyBlock.tsx

import Plot from 'react-plotly.js'

function PlotlyBlock({ plotlyJson }: { plotlyJson: string }) {
  const spec = useMemo(() => JSON.parse(plotlyJson), [plotlyJson])

  return (
    <div className="rounded-lg border overflow-hidden my-2">
      <Plot
        data={spec.data}
        layout={{
          ...spec.layout,
          autosize: true,
          margin: { l: 50, r: 20, t: 40, b: 50 },
          paper_bgcolor: 'transparent',
          plot_bgcolor: 'transparent',
          font: { family: 'var(--font-ui)' },
        }}
        config={{
          responsive: true,
          displayModeBar: true,
          modeBarButtonsToRemove: ['lasso2d', 'select2d'],
        }}
        useResizeHandler
        className="w-full"
        style={{ height: 400 }}
      />
    </div>
  )
}
```

**Dependencies**: `react-plotly.js` + `plotly.js-dist-min` (use the minified dist to keep bundle size manageable; Plotly core is ~3MB).

**Theme integration**: Charts use transparent background and inherit font from Meridian's design system. Works in both light and dark mode.

## ImageBlock

Renders matplotlib output (base64 PNG):

```tsx
// features/threads/components/blocks/ImageBlock.tsx

function ImageBlock({ base64, format }: { base64: string; format: string }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <>
      <button
        className="rounded-lg overflow-hidden border my-2 cursor-zoom-in hover:opacity-90 transition"
        onClick={() => setExpanded(true)}
      >
        <img
          src={`data:image/${format};base64,${base64}`}
          alt="Python output figure"
          className="max-w-full h-auto max-h-[400px]"
        />
      </button>

      {expanded && (
        <Dialog open onOpenChange={() => setExpanded(false)}>
          <DialogContent className="max-w-[90vw] max-h-[90vh]">
            <img
              src={`data:image/${format};base64,${base64}`}
              alt="Python output figure (expanded)"
              className="w-full h-auto"
            />
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
```

**Click to expand**: Small preview in chat flow, full-size in dialog overlay.

## DataFrameBlock

Renders pandas DataFrame as a styled table:

```tsx
// features/threads/components/blocks/DataFrameBlock.tsx

function DataFrameBlock({ html, title, rowCount, colCount }: Props) {
  return (
    <div className="rounded-lg border overflow-hidden my-2">
      {title && (
        <div className="px-3 py-2 bg-muted/50 border-b text-sm font-medium">
          {title}
          <span className="text-muted-foreground ml-2">
            {rowCount} rows x {colCount} columns
          </span>
        </div>
      )}
      <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
        <div
          className="meridian-table-wrapper"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  )
}
```

**Styling**: The `.meridian-table` class (from DataFrame.to_html) is styled via global CSS:

```css
.meridian-table-wrapper table {
  @apply w-full text-sm;
}
.meridian-table-wrapper th {
  @apply px-3 py-2 text-left font-medium bg-muted/30 border-b sticky top-0;
}
.meridian-table-wrapper td {
  @apply px-3 py-2 border-b tabular-nums;
}
.meridian-table-wrapper tr:hover td {
  @apply bg-muted/20;
}
```

**Scroll**: Horizontal scroll for wide tables, vertical scroll capped at 400px with sticky headers.

## MeshRefBlock

Shows a reference to 3D mesh data with a button to open the viewer:

```tsx
// features/threads/components/blocks/MeshRefBlock.tsx

function MeshRefBlock({ meshRef }: { meshRef: MeshRefData }) {
  const setActiveMeshId = useUIStore(s => s.setActiveMeshId)

  return (
    <div className="rounded-lg border p-3 my-2 flex items-center gap-3">
      <CubeIcon className="w-8 h-8 text-accent-fill" />
      <div className="flex-1">
        <p className="text-sm font-medium">3D Model Generated</p>
        <p className="text-xs text-muted-foreground">
          {meshRef.vertex_count.toLocaleString()} vertices,
          {meshRef.face_count.toLocaleString()} faces
          {meshRef.label_names && ` — ${Object.values(meshRef.label_names).join(', ')}`}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setActiveMeshId(meshRef.mesh_id)}
      >
        View 3D
      </Button>
    </div>
  )
}
```

Clicking "View 3D" sets `activeMeshId` in the UI store, which causes `DocumentPanel` to switch from the editor to `Viewer3DPanel`.

## SSE Event Handlers

### Python Output Handler

```typescript
// features/threads/hooks/sse/eventHandlers/pythonOutputHandler.ts

export function handlePythonOutput(event: PythonOutputEvent, stores: Stores) {
  const { threadStore } = stores

  // Append to the tool call's output buffer
  threadStore.appendPythonOutput(event.toolCallId, {
    stream: event.stream,
    text: event.text,
    sequence: event.sequence,
  })
}
```

### Python Result Handler

```typescript
// features/threads/hooks/sse/eventHandlers/pythonResultHandler.ts

export function handlePythonResult(event: PythonResultEvent, stores: Stores) {
  const { threadStore, uiStore } = stores

  // Add result block to the turn
  threadStore.addPythonResult(event.toolCallId, {
    resultType: event.resultType,
    data: event.data,
  })

  // If mesh_ref, prepare to receive binary data
  if (event.resultType === 'mesh_ref') {
    uiStore.setPendingMeshId(event.data.mesh_id)
  }
}
```

## Block Rendering Integration

The `ActivityBlock` component dispatches to the appropriate renderer:

```tsx
// In ActivityBlock's block rendering logic:
switch (block.blockType) {
  case 'python_output':
    return <PythonOutputBlock lines={block.content.lines} isStreaming={isStreaming} />
  case 'python_result':
    return <PythonResultRenderer result={block.content} />
  // ... existing cases
}

function PythonResultRenderer({ result }: { result: PythonResult }) {
  switch (result.resultType) {
    case 'plotly':    return <PlotlyBlock plotlyJson={result.data.plotly_json} />
    case 'image':     return <ImageBlock base64={result.data.base64} format={result.data.format} />
    case 'dataframe': return <DataFrameBlock {...result.data} />
    case 'mesh_ref':  return <MeshRefBlock meshRef={result.data} />
  }
}
```

## Dependencies

```
react-plotly.js            # React wrapper for Plotly
plotly.js-dist-min         # Plotly core (minified, ~1.2MB gzip)
```

## Performance Notes

- **Plotly**: Lazy-loaded via dynamic import to avoid blocking initial bundle
- **Large DataFrames**: HTML is pre-rendered server-side, no client-side parsing
- **Base64 images**: Typical matplotlib PNG at 150dpi is 50-200KB — fine for inline display
- **Multiple results per turn**: A single `execute_python` call can emit multiple results (e.g., a chart + a table). They render in sequence within the turn.

## Related Docs

- [Stream Extensions](../backend/stream-extensions.md) — event types and payloads
- [3D Viewer](viewer-3d.md) — mesh visualization in right panel
- [execute_python Tool](../backend/execute-python.md) — produces these results
