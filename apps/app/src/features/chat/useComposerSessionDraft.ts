/** Per-tab unsent authoring state; submission journals own dispatched messages. */
import { useEffect, useMemo } from "react";
import type { ComposerDraftChange, ComposerDraftSnapshot } from "@/components/app/composer";
import {
  parseRestorableComposerDraft,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";

export type ComposerDraftScope = { kind: "chat" | "new-chat"; id: string };
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export class ComposerSessionDraft {
  readonly key: string;
  readonly initialDraft: ComposerDraftSnapshot | null;
  private current: ComposerDraftSnapshot | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(
    private accountId: string,
    scope: ComposerDraftScope,
    private storage: () => StoragePort = () => window.sessionStorage,
  ) {
    this.key = `meridian:composer-draft:v1:${JSON.stringify([accountId, scope.kind, scope.id])}`;
    let draft: ComposerDraftSnapshot | null = null;
    try {
      const raw = this.storage().getItem(this.key);
      const record = raw ? JSON.parse(raw) : null;
      if (record?.version === 1 && record.accountId === accountId)
        draft = parseRestorableComposerDraft(record.draft);
    } catch {
      /* Storage is best effort; the live editor is always usable. */
    }
    this.current = this.initialDraft = draft;
  }

  updateDraft = (change: ComposerDraftChange): void => {
    this.current = change.snapshot;
    this.dirty = true;
    if (this.timer !== null) clearTimeout(this.timer);
    // An empty draft (Send or explicit deletion) must never resurrect on reload.
    if (!change.text) this.flush();
    else this.timer = setTimeout(this.flush, 250);
  };

  /** Call only after the submission journal has durably accepted ownership. */
  handoff = (): void => {
    this.current = null;
    this.dirty = true;
    this.flush();
  };

  flush = (): void => {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    try {
      const draft = this.current && parseRestorableComposerDraft(this.current);
      if (!draft || !serializeComposerDraft(draft.doc).text) this.storage().removeItem(this.key);
      else
        this.storage().setItem(
          this.key,
          JSON.stringify({ version: 1, accountId: this.accountId, draft }),
        );
      this.dirty = false;
    } catch {
      /* A denied/quota-full store must not interrupt authoring or Send. */
    }
  };
}

export function useComposerSessionDraft(accountId: string, scope: ComposerDraftScope) {
  const owner = useMemo(
    () => new ComposerSessionDraft(accountId, scope),
    [accountId, scope.kind, scope.id],
  );
  useEffect(() => {
    window.addEventListener("pagehide", owner.flush);
    return () => {
      window.removeEventListener("pagehide", owner.flush);
      owner.flush();
    };
  }, [owner]);
  return owner;
}
