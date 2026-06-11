export function ProjectShellStyles() {
  return (
    <style>{`
      :root {
        color-scheme: light;
        font-family: Inter, ui-sans-serif, system-ui, sans-serif;
        background: Canvas;
        color: CanvasText;
      }

      body {
        margin: 0;
      }

      button,
      textarea {
        font: inherit;
      }

      .project-shell {
        min-height: 100vh;
        background: Canvas;
      }

      .shell-topbar {
        align-items: center;
        border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
        display: flex;
        gap: 1.5rem;
        justify-content: space-between;
        padding: 1rem 1.25rem;
      }

      .shell-topbar h1,
      .pane-header h2 {
        margin: 0;
      }

      .eyebrow {
        color: color-mix(in srgb, CanvasText 60%, transparent);
        font-size: 0.75rem;
        letter-spacing: 0.08em;
        margin: 0 0 0.25rem;
        text-transform: uppercase;
      }

      .debug-grid {
        display: grid;
        gap: 0.5rem 1rem;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        margin: 0;
      }

      .debug-grid div {
        min-width: 0;
      }

      .debug-grid dt {
        color: color-mix(in srgb, CanvasText 58%, transparent);
        font-size: 0.7rem;
      }

      .debug-grid dd {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.75rem;
        margin: 0;
        max-width: 11rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .workbench-grid {
        display: grid;
        gap: 1rem;
        grid-template-columns: minmax(20rem, 26rem) minmax(0, 1fr);
        min-height: calc(100vh - 6rem);
        padding: 1rem;
      }

      .pane {
        background: Field;
        border: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
        border-radius: 1rem;
        display: flex;
        min-height: 0;
        overflow: hidden;
      }

      .chat-pane,
      .editor-pane {
        flex-direction: column;
      }

      .pane-header {
        align-items: center;
        border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
        display: flex;
        gap: 1rem;
        justify-content: space-between;
        padding: 1rem;
      }

      .pane-header h2 {
        font-size: 1rem;
      }

      .debug-stack {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
        justify-content: flex-end;
      }

      .debug-pill {
        background: color-mix(in srgb, CanvasText 8%, transparent);
        border-radius: 999px;
        font-size: 0.75rem;
        padding: 0.25rem 0.5rem;
        white-space: nowrap;
      }

      .turn-list {
        display: flex;
        flex: 1;
        flex-direction: column;
        gap: 0.75rem;
        overflow: auto;
        padding: 1rem;
      }

      .empty-state,
      .error {
        color: color-mix(in srgb, CanvasText 60%, transparent);
        margin: 0;
      }

      .error {
        color: Mark;
        padding: 0 1rem;
      }

      .turn {
        border: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
        border-radius: 0.8rem;
        padding: 0.75rem;
      }

      .turn.user {
        background: color-mix(in srgb, Highlight 10%, Field);
      }

      .turn.assistant {
        background: Canvas;
      }

      .turn p {
        margin: 0.25rem 0 0;
        white-space: pre-wrap;
      }

      .turn-role {
        color: color-mix(in srgb, CanvasText 58%, transparent);
        font-size: 0.75rem;
        font-weight: 700;
      }

      .composer {
        border-top: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
        display: grid;
        gap: 0.75rem;
        padding: 1rem;
      }

      .composer textarea,
      .editor-textarea {
        background: Canvas;
        border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
        border-radius: 0.75rem;
        color: CanvasText;
        resize: vertical;
      }

      .composer textarea {
        min-height: 4.5rem;
        padding: 0.75rem;
      }

      .composer button {
        justify-self: end;
        padding: 0.55rem 0.9rem;
      }

      .editor-textarea {
        flex: 1;
        line-height: 1.65;
        margin: 1rem;
        padding: 1.25rem;
        resize: none;
      }

      .sr-only {
        height: 1px;
        margin: -1px;
        overflow: hidden;
        position: absolute;
        width: 1px;
      }

      @media (max-width: 860px) {
        .shell-topbar,
        .workbench-grid {
          display: block;
        }

        .debug-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
          margin-top: 1rem;
        }

        .pane {
          min-height: 60vh;
        }

        .editor-pane {
          margin-top: 1rem;
        }
      }
    `}</style>
  );
}
