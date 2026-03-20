# React writing platform library recommendations (2026-03-19)

## Stack assumptions
React 19, CodeMirror 6, Yjs, SSE chat streaming, multi-panel layout, command palette, Zustand, Dexie, Storybook, Tailwind v4.

## Recommendations
1. Panel layout / resizing: `react-resizable-panels`
2. Virtual list / scroll: `@tanstack/react-virtual`
3. Command palette: `cmdk`
4. Tree component: `react-arborist`
5. Drag and drop: `@atlaskit/pragmatic-drag-and-drop`
6. Toast / notifications: `sonner`
7. Keyboard shortcuts: `react-hotkeys-hook` (scope on top of hotkeys-js)
8. Markdown parsing for chat/previews: `react-markdown` (unified/remark/rehype pipeline)
9. EPUB generation: server-side `pandoc` + `epubcheck`
10. Date/time: `date-fns` (Temporal not baseline)
11. Charts: `@visx/xychart`
12. Animation: `motion`
13. Form handling: `react-hook-form`
14. Data fetching: `@tanstack/react-query` for server state + Zustand for local UI/editor state
15. SSE client: `fetch` + `eventsource-parser`
16. PDF generation: server-side `playwright` PDF pipeline
17. Syntax highlighting: CodeMirror 6 language packages in editor; `shiki` for chat/docs blocks
18. Text analysis: `compromise` + custom scoring heuristics
19. Missing high-value libraries: `zod`, `fuse.js`, `sentry`, `posthog-js`

## Key ecosystem signals captured
- npm package recency and package metadata captured via `npm view`
- npm weekly downloads captured via npm downloads API
- production/architecture notes captured from project docs, GitHub READMEs, and vendor engineering posts

## Notes on VS Code web and Linear
- VS Code web uses custom `SplitView` and `Grid` implementations in the VS Code codebase (not React pane libraries).
- Linear publicly documents command-menu-first UX (`Cmd+K`) but does not publicly document specific third-party UI layout/palette library choices.

## Source index
- https://github.com/bvaughn/react-resizable-panels
- https://github.com/johnwalley/allotment
- https://github.com/nomcopter/react-mosaic
- https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/splitview/splitview.ts
- https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/grid/grid.ts
- https://tanstack.com/virtual/latest/docs/introduction
- https://github.com/TanStack/virtual
- https://github.com/dip/cmdk
- https://ui.shadcn.com/docs/components/command
- https://github.com/brimdata/react-arborist
- https://atlassian.design/components/pragmatic-drag-and-drop/core-package/
- https://www.atlassian.com/blog/design/designed-for-delight-built-for-performance
- https://github.com/emilkowalski/sonner
- https://github.com/johannesklauss/react-hotkeys-hook
- https://github.com/jaywcjlove/hotkeys-js
- https://github.com/remarkjs/react-markdown
- https://github.com/markdown-it/markdown-it
- https://github.com/jgm/pandoc
- https://pandoc.org/MANUAL.html
- https://github.com/w3c/epubcheck
- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal
- https://github.com/date-fns/date-fns
- https://github.com/airbnb/visx
- https://github.com/motiondivision/motion
- https://github.com/react-hook-form/react-hook-form
- https://tanstack.com/query/latest/docs/framework/react/overview
- https://github.com/pmndrs/zustand
- https://github.com/rexxars/eventsource-parser
- https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
- https://playwright.dev/docs/api/class-page#page-pdf
- https://react-pdf.org/
- https://codemirror.net/
- https://github.com/shikijs/shiki
- https://github.com/spencermountain/compromise
- https://linear.app/docs/project-templates
