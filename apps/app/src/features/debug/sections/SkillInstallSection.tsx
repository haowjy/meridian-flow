/**
 * Milestone 2 throwaway: account skill add/delete. Deleted before release.
 * i18n exception: DEV-only.
 */
import { useState } from "react";

import { deleteRequest, postJson } from "@/client/api/http-client";

const ADD_PATH = "/api/debug/account-skills";

export function SkillInstallSection() {
  const [slug, setSlug] = useState("story-review");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    setStatus(null);
    try {
      const paste = name.trim() || description.trim() || body;
      const payload = paste
        ? { slug: slug.trim(), name: name.trim(), description: description.trim(), body }
        : { slug: slug.trim() };
      const installed = await postJson<{ slug: string; name: string }>(ADD_PATH, payload);
      setStatus(`Installed ${installed.slug} (${installed.name})`);
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setStatus(null);
    try {
      await deleteRequest(`${ADD_PATH}/${encodeURIComponent(slug.trim())}`);
      setStatus(`Deleted ${slug.trim()}`);
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex flex-col gap-0.5 text-meta text-muted-foreground">
        slug
        <input
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          className="h-7 rounded border border-border bg-transparent px-2 text-xs text-foreground"
        />
      </label>
      <label className="flex flex-col gap-0.5 text-meta text-muted-foreground">
        name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="h-7 rounded border border-border bg-transparent px-2 text-xs text-foreground"
        />
      </label>
      <label className="flex flex-col gap-0.5 text-meta text-muted-foreground">
        description
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className="h-7 rounded border border-border bg-transparent px-2 text-xs text-foreground"
        />
      </label>
      <label className="flex flex-col gap-0.5 text-meta text-muted-foreground">
        body
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={3}
          className="rounded border border-border bg-transparent px-2 py-1 text-xs text-foreground"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void add()}
          className="focus-ring min-w-0 flex-1 rounded border border-border px-2 py-1.5 text-left text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
        >
          Add
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void remove()}
          className="focus-ring min-w-0 flex-1 rounded border border-border px-2 py-1.5 text-left text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
        >
          Delete
        </button>
      </div>
      {status ? (
        <p className="text-meta text-muted-foreground" role="status">
          {status}
        </p>
      ) : null}
    </div>
  );
}
