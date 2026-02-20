import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { api } from "@/core/lib/api";
import { isAbortError } from "@/core/lib/errors";
import { useEditorStore } from "@/core/stores/useEditorStore";
import { useUIStore } from "@/core/stores/useUIStore";
import { Button } from "@/shared/components/ui/button";
import { X, Plus, Clock, Bookmark, Shield, User, Sparkles } from "lucide-react";
import type { DocumentSnapshot } from "@/features/documents/types/snapshot";
import { SnapshotListView } from "./SnapshotListView";
import { SnapshotPreviewPane } from "./SnapshotPreviewPane";

type OriginFilter = "all" | "human" | "ai";

interface VersionHistoryPanelProps {
  documentId: string;
}

/**
 * Google Docs-style version history right panel.
 * Shows timestamped snapshots grouped by type: named snapshots as "restore points",
 * auto snapshots as system safety nets.
 */
export function VersionHistoryPanel({ documentId }: VersionHistoryPanelProps) {
  const [snapshots, setSnapshots] = useState<DocumentSnapshot[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newSnapshotName, setNewSnapshotName] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [originFilter, setOriginFilter] = useState<OriginFilter>("all");

  // Explicit preview state (list mode vs preview mode).
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(
    null,
  );
  const [previewSnapshot, setPreviewSnapshot] =
    useState<DocumentSnapshot | null>(null);
  const [previewContent, setPreviewContent] = useState("");
  const [previewBaseContent, setPreviewBaseContent] = useState("");
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const listAbortRef = useRef<AbortController | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);

  const loadSnapshots = useCallback(async () => {
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;

    setIsLoading(true);
    setError(null);
    try {
      const result = await api.snapshots.list(documentId, {
        limit: 50,
        signal: controller.signal,
      });
      setSnapshots(result.snapshots);
      setTotal(result.total);
    } catch (err) {
      if (isAbortError(err)) return;
      setError("Failed to load version history");
    } finally {
      setIsLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    void loadSnapshots();
    return () => {
      listAbortRef.current?.abort();
      previewAbortRef.current?.abort();
    };
  }, [loadSnapshots]);

  const getCurrentBaseContent = useCallback(() => {
    const activeDocument = useEditorStore.getState().activeDocument;
    if (activeDocument?.id !== documentId) {
      return "";
    }
    return activeDocument.content ?? "";
  }, [documentId]);

  const clearPreview = useCallback(() => {
    previewAbortRef.current?.abort();
    setSelectedSnapshotId(null);
    setPreviewSnapshot(null);
    setPreviewContent("");
    setPreviewBaseContent("");
    setIsPreviewLoading(false);
    setPreviewError(null);
  }, []);

  const openPreview = useCallback(
    async (snapshot: DocumentSnapshot) => {
      previewAbortRef.current?.abort();
      const controller = new AbortController();
      previewAbortRef.current = controller;

      setSelectedSnapshotId(snapshot.id);
      setPreviewSnapshot(snapshot);
      setPreviewBaseContent(getCurrentBaseContent());
      setPreviewContent("");
      setPreviewError(null);
      setIsPreviewLoading(true);

      try {
        const result = await api.snapshots.content(documentId, snapshot.id, {
          signal: controller.signal,
        });

        if (controller.signal.aborted) {
          return;
        }

        setPreviewSnapshot(snapshot);
        setPreviewContent(result.content);
      } catch (err) {
        if (isAbortError(err)) return;
        setPreviewError("Failed to load snapshot preview");
      } finally {
        if (!controller.signal.aborted) {
          setIsPreviewLoading(false);
        }
      }
    },
    [documentId, getCurrentBaseContent],
  );

  const handleCreate = async () => {
    if (!newSnapshotName.trim()) return;
    setIsCreating(true);
    try {
      await api.snapshots.create(documentId, newSnapshotName.trim());
      setNewSnapshotName("");
      setShowCreateForm(false);
      await loadSnapshots();
    } catch (err) {
      if (!isAbortError(err)) {
        setError("Failed to create snapshot");
      }
    } finally {
      setIsCreating(false);
    }
  };

  const handleRestore = async () => {
    const snapshotId = previewSnapshot?.id ?? selectedSnapshotId;
    if (!snapshotId) return;

    setRestoringId(snapshotId);
    try {
      await api.snapshots.restore(documentId, snapshotId);
      await loadSnapshots();
      // Restore still requires full reload so editor session picks up restored Yjs state.
      window.location.reload();
    } catch (err) {
      if (!isAbortError(err)) {
        setError("Failed to restore snapshot");
      }
      setRestoringId(null);
    }
  };

  const handleDelete = async (snapshotId: string) => {
    setDeletingId(snapshotId);
    try {
      await api.snapshots.delete(documentId, snapshotId);
      setSnapshots((prev) => prev.filter((s) => s.id !== snapshotId));
      setTotal((prev) => prev - 1);
    } catch (err) {
      if (!isAbortError(err)) {
        setError("Failed to delete snapshot");
      }
    } finally {
      setDeletingId(null);
    }
  };

  const close = () => {
    clearPreview();
    useUIStore.getState().setShowVersionHistory(false);
  };

  // Determine origin from snapshot type
  const getSnapshotOrigin = (
    snap: DocumentSnapshot,
  ): "human" | "ai" | "system" => {
    if (snap.snapshotType === "auto_ai_accept") return "ai";
    if (
      snap.snapshotType === "auto" ||
      snap.snapshotType === "auto_human" ||
      snap.snapshotType === "named"
    )
      return "human";
    return "system"; // pre_restore
  };

  const filteredSnapshots = useMemo(() => {
    return snapshots.filter((snap) => {
      if (originFilter === "all") return true;
      const origin = getSnapshotOrigin(snap);
      if (originFilter === "human") return origin === "human";
      if (originFilter === "ai") return origin === "ai";
      return true;
    });
  }, [snapshots, originFilter]);

  const previewIndex = useMemo(() => {
    if (!selectedSnapshotId) return -1;
    return filteredSnapshots.findIndex(
      (snap) => snap.id === selectedSnapshotId,
    );
  }, [filteredSnapshots, selectedSnapshotId]);

  const canSwitchPrev = previewIndex > 0;
  const canSwitchNext =
    previewIndex >= 0 && previewIndex < filteredSnapshots.length - 1;

  const switchPreview = async (direction: -1 | 1) => {
    if (previewIndex < 0) return;
    const target = filteredSnapshots[previewIndex + direction];
    if (!target) return;
    await openPreview(target);
  };

  const isPreviewMode = selectedSnapshotId !== null;

  const snapshotIcon = (type: DocumentSnapshot["snapshotType"]) => {
    switch (type) {
      case "named":
        return <Bookmark className="text-primary h-3.5 w-3.5" />;
      case "pre_restore":
        return <Shield className="text-warning h-3.5 w-3.5" />;
      case "auto":
      case "auto_human":
      case "auto_ai_accept":
      default:
        return <Clock className="text-muted-foreground h-3.5 w-3.5" />;
    }
  };

  const snapshotLabel = (snap: DocumentSnapshot) => {
    if (snap.name) return snap.name;
    switch (snap.snapshotType) {
      case "pre_restore":
        return "Pre-restore backup";
      case "auto":
        return "Auto-save checkpoint";
      case "auto_human":
        return "Auto-save checkpoint";
      case "auto_ai_accept":
        return "AI auto-save";
      default:
        return "Snapshot";
    }
  };

  // Render origin badge for auto snapshots
  const renderOriginBadge = (snap: DocumentSnapshot) => {
    const origin = getSnapshotOrigin(snap);
    if (snap.snapshotType === "named" || snap.snapshotType === "pre_restore")
      return null;

    if (origin === "ai") {
      return (
        <span className="inline-flex items-center gap-0.5 rounded bg-purple-500/10 px-1 py-0.5 text-[9px] text-purple-600 dark:text-purple-400">
          <Sparkles className="h-2 w-2" />
          AI
        </span>
      );
    }

    if (origin === "human") {
      return (
        <span className="inline-flex items-center gap-0.5 rounded bg-blue-500/10 px-1 py-0.5 text-[9px] text-blue-600 dark:text-blue-400">
          <User className="h-2 w-2" />
          Human
        </span>
      );
    }

    return null;
  };

  const formatDate = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;

    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const selectedSnapshot = previewSnapshot;

  return (
    <div className="bg-background flex h-full flex-col border-l">
      {/* Header */}
      <div className="border-border/50 flex items-center justify-between border-b px-3 py-2">
        <h3 className="text-sm font-medium">Version History</h3>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={close}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Create snapshot */}
      {!isPreviewMode && (
        <div className="border-border/50 border-b px-3 py-2">
          {showCreateForm ? (
            <div className="flex flex-col gap-1.5">
              <input
                type="text"
                className="border-border bg-background focus:ring-primary rounded border px-2 py-1 text-sm focus:ring-1 focus:outline-none"
                placeholder="Snapshot name..."
                value={newSnapshotName}
                onChange={(e) => setNewSnapshotName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCreate();
                  if (e.key === "Escape") setShowCreateForm(false);
                }}
                autoFocus
                disabled={isCreating}
              />
              <div className="flex gap-1">
                <Button
                  size="sm"
                  className="h-6 text-xs"
                  onClick={() => void handleCreate()}
                  disabled={isCreating || !newSnapshotName.trim()}
                >
                  {isCreating ? "Saving..." : "Save"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs"
                  onClick={() => setShowCreateForm(false)}
                  disabled={isCreating}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-full text-xs"
              onClick={() => setShowCreateForm(true)}
            >
              <Plus className="mr-1 h-3 w-3" />
              Create Restore Point
            </Button>
          )}
        </div>
      )}

      {/* Origin Filter */}
      {!isPreviewMode && (
        <div className="border-border/50 border-b px-3 py-2">
          <div className="flex gap-1">
            <Button
              variant={originFilter === "all" ? "default" : "ghost"}
              size="sm"
              className="h-6 flex-1 text-xs"
              onClick={() => setOriginFilter("all")}
            >
              All
            </Button>
            <Button
              variant={originFilter === "human" ? "default" : "ghost"}
              size="sm"
              className="h-6 flex-1 text-xs"
              onClick={() => setOriginFilter("human")}
            >
              <User className="mr-0.5 h-2.5 w-2.5" />
              Human
            </Button>
            <Button
              variant={originFilter === "ai" ? "default" : "ghost"}
              size="sm"
              className="h-6 flex-1 text-xs"
              onClick={() => setOriginFilter("ai")}
            >
              <Sparkles className="mr-0.5 h-2.5 w-2.5" />
              AI
            </Button>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-destructive/10 text-destructive px-3 py-1.5 text-xs">
          {error}
          <Button
            variant="ghost"
            size="sm"
            className="ml-1 h-4 text-xs underline"
            onClick={() => {
              setError(null);
              void loadSnapshots();
            }}
          >
            Retry
          </Button>
        </div>
      )}

      {/* Preview mode */}
      {isPreviewMode ? (
        <SnapshotPreviewPane
          snapshot={selectedSnapshot}
          selectedSnapshotId={selectedSnapshotId}
          previewBaseContent={previewBaseContent}
          previewContent={previewContent}
          isPreviewLoading={isPreviewLoading}
          previewError={previewError}
          restoringId={restoringId}
          canSwitchPrev={canSwitchPrev}
          canSwitchNext={canSwitchNext}
          formatDate={formatDate}
          snapshotIcon={snapshotIcon}
          snapshotLabel={snapshotLabel}
          onSwitchPrev={() => void switchPreview(-1)}
          onSwitchNext={() => void switchPreview(1)}
          onRestore={() => void handleRestore()}
          onClosePreview={clearPreview}
          onRetryPreview={() => {
            if (!selectedSnapshotId) return;
            const snapshot = snapshots.find(
              (item) => item.id === selectedSnapshotId,
            );
            if (!snapshot) {
              setPreviewError("Snapshot no longer available");
              return;
            }
            void openPreview(snapshot);
          }}
        />
      ) : (
        <SnapshotListView
          snapshots={snapshots}
          filteredSnapshots={filteredSnapshots}
          total={total}
          originFilter={originFilter}
          isLoading={isLoading}
          isPreviewLoading={isPreviewLoading}
          deletingId={deletingId}
          snapshotIcon={snapshotIcon}
          snapshotLabel={snapshotLabel}
          renderOriginBadge={renderOriginBadge}
          formatDate={formatDate}
          onOpenPreview={(snapshot) => void openPreview(snapshot)}
          onDelete={(snapshotId) => void handleDelete(snapshotId)}
        />
      )}
    </div>
  );
}
