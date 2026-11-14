/**
 * LiveDraftNotice — on Live, a page the toggle's Work drafts says what the draft does to it, with
 * Show draft (the toggle to Draft, the page on its draft). A page the draft created has no live
 * version, so it stays on its draft under Live and says that instead. On Draft the page shows
 * the draft itself and nothing is said.
 */
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Info } from "lucide-react";
import { useDocumentDraftHints } from "@/client/query/useDocumentDraftHints";
import type { OpenDocument } from "@/client/stores";
import { DocumentNotice } from "@/components/app/DocumentNotice";
import { Button } from "@/components/ui/button";
import {
  draftNoticeSentence,
  newInDraftSentence,
  treeLineOf,
} from "@/features/draft-review/tree-line";
import { useHostDocumentPaint } from "../DocumentReview";
import { useShellTreeVersion } from "../tree-version";

export type LiveDraftCue = { ownerKey: string; sentence: string; showDraft: () => void };

export function useLiveDraftCue(projectId: string, document: OpenDocument): LiveDraftCue | null {
  useLingui();
  const shell = useShellTreeVersion();
  const paint = useHostDocumentPaint();
  const hints = useDocumentDraftHints(projectId, document.documentId, {
    enabled: document.kind !== "new",
  });
  if (!shell?.offered || shell.showing !== "live" || document.kind === "new") return null;
  const draft = shell.draftOf(document.documentId);
  if (!draft) return null;
  const work = hints.find((hint) => hint.owner === shell.ownerKey)?.label ?? shell.name;
  const showDraft = () => shell.showDraft(document.documentId);
  if (draft.draft.isNew)
    return { ownerKey: shell.ownerKey, sentence: newInDraftSentence(work), showDraft };
  if (paint?.showing !== "live") return null;
  return {
    ownerKey: shell.ownerKey,
    sentence: draftNoticeSentence(work, treeLineOf(draft.draft), draft.draft.hasDraft),
    showDraft,
  };
}

export function LiveDraftNotice({
  projectId,
  document,
}: {
  projectId: string;
  document: OpenDocument;
}) {
  const cue = useLiveDraftCue(projectId, document);
  if (!cue) return null;
  return (
    <div className="px-4 pt-3" data-live-draft-notice>
      <DocumentNotice
        icon={<Info aria-hidden className="size-4" />}
        action={
          <Button variant="outline" size="xs" onClick={cue.showDraft}>
            <Trans>Show draft</Trans>
          </Button>
        }
      >
        {cue.sentence}
      </DocumentNotice>
    </div>
  );
}
