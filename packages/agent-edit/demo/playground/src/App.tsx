// Top-level demo UI: command panel, output log, block hash overlay, scripted
// tour. All mutations go through `core.write()` — the editor is read-only.
import type { WriteCommand } from "@meridian/agent-edit";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";

import { EditorPanel } from "./EditorPanel.js";
import { createPlaygroundEnv, type PlaygroundEnv } from "./env.js";
import { runScriptedTour } from "./tour.js";

const DEFAULT_DOC_ID = "chapter-1.mdx";
const SEED_CONTENT = `# Chapter 1: The Wake

The sword hummed beneath the old shrine.

Moonlight pooled across the floor.`;

type CommandKind = "create" | "read" | "insert" | "replace" | "undo" | "redo";

interface LogEntry {
  id: number;
  label: string;
  body: string;
  ok: boolean;
}

interface BlockLine {
  index: number;
  hash: string;
  text: string;
}

export function App() {
  // Construct the env once. We don't recreate on hot reload — that would
  // wipe the live Y.Doc and lose state mid-demo.
  const envRef = useRef<PlaygroundEnv | null>(null);
  if (!envRef.current) envRef.current = createPlaygroundEnv();
  const env = envRef.current;

  const [docId, setDocId] = useState(DEFAULT_DOC_ID);
  const [doc, setDoc] = useState<Y.Doc | null>(null);
  const [blocks, setBlocks] = useState<BlockLine[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [seeded, setSeeded] = useState(false);
  const [running, setRunning] = useState(false);
  const logIdRef = useRef(0);
  // StrictMode double-mounts effects in dev. Without this guard the seed
  // create() runs twice and inflates the doc with duplicate blocks.
  const seedStartedRef = useRef(false);

  // Seed the doc on first mount via the real write() path.
  useEffect(() => {
    if (seedStartedRef.current) return;
    seedStartedRef.current = true;
    void (async () => {
      await runWrite({ command: "create", file: docId, content: SEED_CONTENT }, "seed (create)");
      setSeeded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once the doc exists in the coordinator, attach to it and subscribe to
  // updates so the block-hash overlay refreshes whenever write() mutates.
  useEffect(() => {
    if (!seeded) return;
    let yDoc: Y.Doc;
    try {
      yDoc = env.coordinator.requireDocument(docId);
    } catch {
      // doc may not be created yet for a different docId — skip until it is.
      setDoc(null);
      setBlocks([]);
      return;
    }
    setDoc(yDoc);
    refreshBlocks(yDoc);
    const onUpdate = () => refreshBlocks(yDoc);
    yDoc.on("update", onUpdate);
    return () => {
      yDoc.off("update", onUpdate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seeded, docId]);

  function refreshBlocks(yDoc: Y.Doc) {
    const lines = env.model.getBlocks(yDoc).map((block, index) => ({
      index,
      hash: env.model.getBlockId(block),
      text: env.model.getText(block),
    }));
    setBlocks(lines);
  }

  function appendLog(label: string, body: string, ok = true) {
    logIdRef.current += 1;
    const id = logIdRef.current;
    setLog((prev) => [{ id, label, body, ok }, ...prev].slice(0, 50));
  }

  async function runWrite(command: WriteCommand, label: string, turnId?: string) {
    const ctx = turnId ? { ...env.defaultContext, turnId } : env.defaultContext;
    try {
      const response = await env.core.write(command, ctx);
      appendLog(label, response.text, !response.isError);
      return response.text;
    } catch (cause) {
      appendLog(label, String(cause), false);
      return String(cause);
    }
  }

  async function onTour() {
    if (running) return;
    setRunning(true);
    try {
      await runScriptedTour({
        env,
        log: (label, body, ok) => appendLog(label, body, ok),
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="app">
      <header className="app__header">
        <h1>agent-edit playground</h1>
        <div className="app__meta">
          Drives the real <code>@meridian/agent-edit</code> via in-memory fakes. Editor is read-only
          — all changes flow through <code>core.write()</code>.
        </div>
      </header>

      <div className="app__main">
        <section className="panel panel--editor">
          <div className="panel__title">Live document ({docId})</div>
          <div className="panel__note">
            <code>jsx_leaf</code> / <code>jsx_container</code> render as placeholder blocks — the
            real TipTap node-views land in Step 9.
          </div>
          {doc ? (
            <EditorPanel doc={doc} schema={env.schema} />
          ) : (
            <div className="empty">seeding…</div>
          )}
        </section>

        <section className="panel panel--hashes">
          <div className="panel__title">Block hashes</div>
          <ol className="hashes">
            {blocks.map((block) => (
              <li key={`${block.index}-${block.hash}`}>
                <span className="hashes__hash">{block.hash}</span>
                <span className="hashes__text">{previewText(block.text)}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <div className="app__commands">
        <CommandPanel
          docId={docId}
          setDocId={setDocId}
          blocks={blocks}
          onRun={runWrite}
          disabled={running}
        />
        <div className="tour">
          <button type="button" className="tour__button" onClick={onTour} disabled={running}>
            {running ? "Running tour…" : "Run scripted tour"}
          </button>
          <div className="tour__hint">
            Replays the harness highlights: multi-write turn undo, cross-block find, concurrent
            reconcile.
          </div>
        </div>
      </div>

      <section className="panel panel--log">
        <div className="panel__title">write() output log</div>
        <ol className="log">
          {log.map((entry) => (
            <li key={entry.id} className={entry.ok ? "log__entry" : "log__entry log__entry--err"}>
              <div className="log__label">{entry.label}</div>
              <pre className="log__body">{entry.body}</pre>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

interface CommandPanelProps {
  docId: string;
  setDocId: (next: string) => void;
  blocks: BlockLine[];
  onRun: (command: WriteCommand, label: string, turnId?: string) => Promise<string>;
  disabled: boolean;
}

function CommandPanel({ docId, setDocId, blocks, onRun, disabled }: CommandPanelProps) {
  const [kind, setKind] = useState<CommandKind>("read");
  const [find, setFind] = useState("sword");
  const [content, setContent] = useState("");
  const [after, setAfter] = useState("");
  const [before, setBefore] = useState("");
  const [inHash, setInHash] = useState("");
  const [around, setAround] = useState("");
  const [all, setAll] = useState(false);
  const [turnId, setTurnId] = useState("");
  const [viewFormat, setReadFormat] = useState<"full" | "outline">("full");

  const hashOptions = useMemo(() => blocks.map((b) => b.hash), [blocks]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const command = buildCommand({
      kind,
      docId,
      find,
      content,
      after,
      before,
      inHash,
      around,
      all,
      viewFormat,
    });
    if (!command) return;
    const label = describeCommand(command);
    await onRun(command, label, turnId || undefined);
  }

  return (
    <form className="panel panel--cmd" onSubmit={onSubmit}>
      <div className="panel__title">Command</div>
      <div className="row">
        <label>
          file
          <input value={docId} onChange={(e) => setDocId(e.target.value)} />
        </label>
        <label>
          command
          <select value={kind} onChange={(e) => setKind(e.target.value as CommandKind)}>
            <option value="create">create</option>
            <option value="read">read</option>
            <option value="insert">insert</option>
            <option value="replace">replace</option>
            <option value="undo">undo</option>
            <option value="redo">redo</option>
          </select>
        </label>
        <label>
          turnId (optional)
          <input value={turnId} onChange={(e) => setTurnId(e.target.value)} placeholder="auto" />
        </label>
      </div>

      {kind === "read" && (
        <>
          <div className="row">
            <label>
              format
              <select
                value={viewFormat}
                onChange={(e) => setReadFormat(e.target.value as "full" | "outline")}
              >
                <option value="full">full</option>
                <option value="outline">outline</option>
              </select>
            </label>
          </div>
          <div className="row">
            <HashPickerInput label="in" value={inHash} onChange={setInHash} options={hashOptions} />
            <HashPickerInput
              label="around"
              value={around}
              onChange={setAround}
              options={hashOptions}
            />
          </div>
        </>
      )}

      {(kind === "create" || kind === "insert" || kind === "replace") && (
        <div className="row row--wide">
          <label className="row__wide">
            content
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={4}
              placeholder={
                kind === "create" ? "# Heading\n\nA paragraph." : "Replacement / inserted text"
              }
            />
          </label>
        </div>
      )}

      {kind === "insert" && (
        <>
          <div className="row">
            <HashPickerInput
              label="after"
              value={after}
              onChange={setAfter}
              options={hashOptions}
            />
            <HashPickerInput
              label="before"
              value={before}
              onChange={setBefore}
              options={hashOptions}
            />
          </div>
          <div className="row">
            <label>
              find
              <input
                value={find}
                onChange={(e) => setFind(e.target.value)}
                placeholder="text to find"
              />
            </label>
            <HashPickerInput label="in" value={inHash} onChange={setInHash} options={hashOptions} />
            <HashPickerInput
              label="around"
              value={around}
              onChange={setAround}
              options={hashOptions}
            />
            <label>
              all
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            </label>
          </div>
        </>
      )}

      {kind === "replace" && (
        <div className="row">
          <label>
            find
            <input
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder="text to find"
            />
          </label>
          <HashPickerInput label="in" value={inHash} onChange={setInHash} options={hashOptions} />
          <HashPickerInput
            label="around"
            value={around}
            onChange={setAround}
            options={hashOptions}
          />
          <label>
            all
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          </label>
        </div>
      )}

      <div className="row row--actions">
        <button type="submit" disabled={disabled}>
          run write()
        </button>
      </div>
    </form>
  );
}

function HashPickerInput({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <label>
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        list={`hashes-${label}`}
        placeholder="block hash"
      />
      <datalist id={`hashes-${label}`}>
        {options.map((h) => (
          <option key={h} value={h} />
        ))}
      </datalist>
    </label>
  );
}

function buildCommand(input: {
  kind: CommandKind;
  docId: string;
  find: string;
  content: string;
  after: string;
  before: string;
  inHash: string;
  around: string;
  all: boolean;
  viewFormat: "full" | "outline";
}): WriteCommand | null {
  const { kind, docId } = input;
  switch (kind) {
    case "create":
      return { command: "create", file: docId, content: input.content };
    case "read":
      return {
        command: "read",
        file: docId,
        format: input.viewFormat,
        ...(input.inHash ? { in: input.inHash } : {}),
        ...(input.around ? { around: input.around } : {}),
      };
    case "insert": {
      // No-anchor insert is valid — the package appends at the end of the doc.
      const cmd: WriteCommand = {
        command: "insert",
        file: docId,
        content: input.content,
        ...(input.after ? { after: input.after } : {}),
        ...(input.before ? { before: input.before } : {}),
        ...(input.find ? { find: input.find } : {}),
        ...(input.inHash ? { in: input.inHash } : {}),
        ...(input.around ? { around: input.around } : {}),
        ...(input.all ? { all: true } : {}),
      } as WriteCommand;
      return cmd;
    }
    case "replace": {
      const cmd: WriteCommand = {
        command: "replace",
        file: docId,
        content: input.content,
        ...(input.find ? { find: input.find } : {}),
        ...(input.inHash ? { in: input.inHash } : {}),
        ...(input.around ? { around: input.around } : {}),
        ...(input.all ? { all: true } : {}),
      } as WriteCommand;
      return cmd;
    }
    case "undo":
      return { command: "undo", file: docId };
    case "redo":
      return { command: "redo", file: docId };
  }
}

function describeCommand(command: WriteCommand): string {
  const parts: string[] = [`write(${command.command}`];
  if ("file" in command) parts.push(`file=${command.file}`);
  if ("find" in command && command.find) parts.push(`find="${command.find}"`);
  if ("after" in command && command.after) parts.push(`after=${command.after}`);
  if ("before" in command && command.before) parts.push(`before=${command.before}`);
  if ("in" in command && command.in) parts.push(`in=${command.in}`);
  if ("around" in command && command.around) parts.push(`around=${command.around}`);
  if ("all" in command && command.all) parts.push("all=true");
  return `${parts.join(" ")})`;
}

function previewText(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed;
}
