import { useState, useEffect, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { Loader2, ChevronDown, Trash2, X } from "lucide-react";
import { useProjectStore } from "@/core/stores/useProjectStore";
import { useSkillStore } from "@/core/stores/useSkillStore";
import { useIsMobile } from "@/core/hooks";
import { Button } from "@/shared/components/ui/button";
import { Textarea } from "@/shared/components/ui/textarea";
import { Switch } from "@/shared/components/ui/switch";
import { PanelHeader } from "@/shared/components/layout/headers";
import { DocumentsToggle } from "@/shared/components/layout/DocumentsToggle";
import {
  selectEffectiveRightCollapsed,
  useUIStore,
} from "@/core/stores/useUIStore";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { Skill } from "@/features/skills/types/skill";

interface ProjectSettingsPanelProps {
  projectId: string;
}

interface ProjectSettingsPanelContentProps {
  projectId: string;
}

// Default tools available for AI
// str_replace_based_edit_tool handles view + edit; doc_tree was merged into it
const DEFAULT_TOOLS = [
  {
    id: "str_replace_based_edit_tool",
    label: "View & Edit Documents",
    group: "document",
  },
  { id: "doc_search", label: "Search Documents", group: "document" },
  { id: "tavily_web_search", label: "Web Search", group: "external" },
];

/**
 * Collapsible section header with chevron animation and optional actions.
 * Actions are placed INSIDE the trigger row (between title and chevron) with
 * stopPropagation to prevent toggle when clicking action buttons.
 */
function SectionHeader({
  title,
  badge,
  open,
  actions,
}: {
  title: string;
  badge?: string | number;
  open: boolean;
  actions?: React.ReactNode;
}) {
  return (
    <CollapsibleTrigger className="text-foreground flex w-full items-center justify-between rounded-sm px-3 py-2 text-lg font-medium transition-colors hover:bg-[var(--hover)] md:text-sm">
      <span className="flex items-center gap-2">
        {title}
        {badge !== undefined && (
          <span className="text-muted-foreground text-sm md:text-xs">
            ({badge})
          </span>
        )}
      </span>
      <span className="flex items-center gap-2">
        {/* Actions with stopPropagation to prevent toggle when clicking buttons */}
        {/* -my-1 absorbs any height expansion from buttons without affecting visual appearance */}
        {actions && (
          <span
            onClick={(e) => e.stopPropagation()}
            className="-my-1 flex items-center gap-1"
          >
            {actions}
          </span>
        )}
        <ChevronDown
          className={cn(
            "text-muted-foreground size-4 transition-transform duration-200 md:size-4.5",
            open && "rotate-180",
          )}
        />
      </span>
    </CollapsibleTrigger>
  );
}

/**
 * Row with label and switch toggle
 */
function SettingsRow({
  label,
  labelTone = "default",
  indent,
  right,
  className,
}: {
  label: string;
  labelTone?: "default" | "muted";
  indent?: boolean;
  right: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-10 items-center justify-between gap-3 px-3 py-0.5 md:min-h-7",
        indent && "pl-6",
        className,
      )}
    >
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-lg md:text-sm",
          labelTone === "default" ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
      <div className="shrink-0">{right}</div>
    </div>
  );
}

function SettingsGroupHeader({
  title,
  open,
}: {
  title: string;
  open: boolean;
}) {
  return (
    <CollapsibleTrigger className="text-muted-foreground flex w-full items-center justify-between rounded-sm px-3 py-1 text-base font-medium tracking-wide uppercase transition-colors hover:bg-[var(--hover)] md:text-xs">
      <span className="truncate">{title}</span>
      <ChevronDown
        className={cn(
          "text-muted-foreground size-5 transition-transform duration-200 md:size-3.5",
          open && "rotate-180",
        )}
      />
    </CollapsibleTrigger>
  );
}

function ToolRow({
  label,
  checked,
  onCheckedChange,
  disabled,
  isSaving,
  indent,
  isMobile,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  isSaving?: boolean;
  indent?: boolean;
  isMobile?: boolean;
}) {
  return (
    <SettingsRow
      label={label}
      labelTone={checked ? "default" : "muted"}
      indent={indent}
      right={
        <div className="flex items-center gap-1.5">
          {isSaving && (
            <Loader2 className="text-muted-foreground size-3 animate-spin" />
          )}
          <Switch
            checked={checked}
            onCheckedChange={onCheckedChange}
            disabled={disabled || isSaving}
            size={isMobile ? "default" : "md"}
          />
        </div>
      }
    />
  );
}

/**
 * Skill row with toggle and delete button
 */
function SkillRow({
  skill,
  onToggle,
  onDelete,
  isUpdating,
  isMobile,
}: {
  skill: Skill;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
  isUpdating: boolean;
  isMobile?: boolean;
}) {
  return (
    <SettingsRow
      className="group"
      label={skill.name}
      labelTone={skill.enabled ? "default" : "muted"}
      right={
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onDelete}
            className="text-muted-foreground hover:text-error size-8 opacity-60 transition-opacity md:size-6.5 md:opacity-0 md:group-hover:opacity-100"
          >
            <Trash2 className="size-5 md:size-3.5" />
          </Button>
          <Switch
            checked={skill.enabled}
            onCheckedChange={onToggle}
            disabled={isUpdating}
            size={isMobile ? "default" : "md"}
          />
        </div>
      }
    />
  );
}

/**
 * Content portion of project settings panel (no header).
 * Used by both desktop (ProjectSettingsPanel) and mobile (MobileProjectSettingsView).
 *
 * UX Pattern:
 * - Instructions (text field): explicit Save/Cancel (allows multiple edits before saving)
 * - Tools (toggles): auto-save immediately (users expect instant feedback from switches)
 * - Skills (toggles): auto-save immediately (same as tools)
 *
 * Sections:
 * 1. Instructions - System prompt for AI context
 * 2. Skills - Toggle skill enabled/disabled
 * 3. Tools - Enable/disable AI tools
 */
export function ProjectSettingsPanelContent({
  projectId,
}: ProjectSettingsPanelContentProps) {
  const isMobile = useIsMobile();

  const { project, updateProject } = useProjectStore(
    useShallow((s) => ({
      project: s.projects.find((p) => p.id === projectId),
      updateProject: s.updateProject,
    })),
  );

  const { skills, loadSkills, updateSkill, deleteSkill, isLoadingSkills } =
    useSkillStore(
      useShallow((s) => ({
        skills: s.skills,
        loadSkills: s.loadSkills,
        updateSkill: s.updateSkill,
        deleteSkill: s.deleteSkill,
        isLoadingSkills: s.isLoadingSkills,
      })),
    );

  // Local state for form editing
  const [instructions, setInstructions] = useState("");
  const [disabledTools, setDisabledTools] = useState<string[]>([]);
  const [isAutoAcceptEnabled, setIsAutoAcceptEnabled] = useState(true);
  const [isSavingInstructions, setIsSavingInstructions] = useState(false);
  const [savingToolId, setSavingToolId] = useState<string | null>(null);
  const [isSavingAutoAccept, setIsSavingAutoAccept] = useState(false);
  const [isInstructionsDirty, setIsInstructionsDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatingSkillId, setUpdatingSkillId] = useState<string | null>(null);

  // Collapsible section open state
  const [instructionsOpen, setInstructionsOpen] = useState(true);
  const [skillsOpen, setSkillsOpen] = useState(true);
  const [toolsOpen, setToolsOpen] = useState(true);
  const [documentToolsOpen, setDocumentToolsOpen] = useState(true);
  const [externalToolsOpen, setExternalToolsOpen] = useState(true);

  // Sync local state from project
  useEffect(() => {
    if (project) {
      setInstructions(project.systemPrompt ?? "");
      setDisabledTools(project.preferences?.disabledTools ?? []);
      setIsAutoAcceptEnabled(project.autoAcceptProposals ?? true);
      setIsInstructionsDirty(false);
      setError(null);
    }
  }, [project]);

  // Load skills when panel mounts
  useEffect(() => {
    const abortController = new AbortController();
    loadSkills(projectId, abortController.signal);
    return () => abortController.abort();
  }, [projectId, loadSkills]);

  // Check if instructions have changed
  const checkInstructionsDirty = useCallback(
    (newInstructions: string) => {
      if (!project) return false;
      const savedInstructions = project.systemPrompt ?? "";
      return newInstructions !== savedInstructions;
    },
    [project],
  );

  const handleInstructionsChange = (value: string) => {
    setInstructions(value);
    setError(null);
    setIsInstructionsDirty(checkInstructionsDirty(value));
  };

  // Tool toggle - auto-save immediately (UX: users expect instant feedback from toggles)
  const handleToolToggle = async (toolId: string, enabled: boolean) => {
    const previousDisabled = disabledTools;
    const newDisabled = enabled
      ? disabledTools.filter((id) => id !== toolId)
      : [...disabledTools, toolId];

    // Optimistic update
    setDisabledTools(newDisabled);
    setSavingToolId(toolId);
    setError(null);

    try {
      await updateProject(projectId, {
        preferences: { disabledTools: newDisabled },
      });
    } catch (err) {
      // Revert on error
      setDisabledTools(previousDisabled);
      setError(
        err instanceof Error ? err.message : "Failed to update tool setting",
      );
    } finally {
      setSavingToolId(null);
    }
  };

  // Auto-accept toggle - auto-save immediately (same UX as tools)
  const handleAutoAcceptToggle = async (enabled: boolean) => {
    const previousValue = isAutoAcceptEnabled;

    // Optimistic update
    setIsAutoAcceptEnabled(enabled);
    setIsSavingAutoAccept(true);
    setError(null);

    try {
      await updateProject(projectId, {
        autoAcceptProposals: enabled,
      });
    } catch (err) {
      // Revert on error
      setIsAutoAcceptEnabled(previousValue);
      setError(
        err instanceof Error
          ? err.message
          : "Failed to update auto-accept setting",
      );
    } finally {
      setIsSavingAutoAccept(false);
    }
  };

  // Save instructions (explicit save)
  const handleSaveInstructions = async () => {
    if (!project || !isInstructionsDirty) return;

    setIsSavingInstructions(true);
    setError(null);
    try {
      const trimmed = instructions.trim();
      await updateProject(projectId, {
        systemPrompt: trimmed || null,
      });
      setIsInstructionsDirty(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save instructions",
      );
    } finally {
      setIsSavingInstructions(false);
    }
  };

  const handleCancelInstructions = () => {
    if (project) {
      setInstructions(project.systemPrompt ?? "");
      setIsInstructionsDirty(false);
      setError(null);
    }
  };

  // Skill toggle - immediate save
  const handleSkillToggle = async (skill: Skill, enabled: boolean) => {
    setUpdatingSkillId(skill.id);
    try {
      await updateSkill(projectId, skill.id, { enabled });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update skill");
    } finally {
      setUpdatingSkillId(null);
    }
  };

  // Skill delete
  const handleSkillDelete = async (skill: Skill) => {
    if (!confirm(`Delete skill "${skill.name}"? This cannot be undone.`))
      return;
    try {
      await deleteSkill(projectId, skill.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete skill");
    }
  };

  const isToolEnabled = (toolId: string) => !disabledTools.includes(toolId);

  const documentTools = DEFAULT_TOOLS.filter((t) => t.group === "document");
  const externalTools = DEFAULT_TOOLS.filter((t) => t.group === "external");

  return (
    <div className="mx-auto w-full max-w-3xl pt-2">
      {/* Error display */}
      {error && (
        <div className="text-error bg-error/10 mx-3 mb-3 flex items-center justify-between rounded-sm p-2 text-sm">
          <span>{error}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setError(null)}
            className="text-error hover:text-error"
          >
            <X className="size-3" />
          </Button>
        </div>
      )}

      {/* Instructions Section - explicit Save/Cancel in header */}
      <Collapsible
        open={instructionsOpen}
        onOpenChange={setInstructionsOpen}
        className="border-b"
      >
        <SectionHeader
          title="Instructions"
          open={instructionsOpen}
          actions={
            isInstructionsDirty && (
              <>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={handleCancelInstructions}
                  disabled={isSavingInstructions}
                  className="text-muted-foreground h-5 px-1.5 text-xs"
                >
                  Cancel
                </Button>
                <Button
                  size="xs"
                  onClick={handleSaveInstructions}
                  disabled={isSavingInstructions}
                  className="h-5 px-1.5 text-xs"
                >
                  {isSavingInstructions && (
                    <Loader2 className="mr-1 size-2.5 animate-spin" />
                  )}
                  Save
                </Button>
              </>
            )
          }
        />
        <CollapsibleContent>
          <div className="flex flex-col gap-2 px-3 pb-3">
            <Textarea
              value={instructions}
              onChange={(e) => handleInstructionsChange(e.target.value)}
              placeholder="Give the AI context about this project..."
              disabled={isSavingInstructions}
              className="min-h-[120px] resize-y"
            />
            <p className="text-muted-foreground text-xs">
              Included in every AI conversation for this project.
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <div className="border-b pb-1">
        <div className="px-3 py-2 text-lg font-medium md:text-sm">
          Collaboration
        </div>
        <div className="flex min-h-10 items-center justify-between gap-3 px-3 py-0.5 md:min-h-7">
          <div className="min-w-0 flex-1">
            <p className="text-foreground text-lg md:text-sm">
              Auto-accept AI proposals
            </p>
            <p className="text-muted-foreground text-sm md:text-xs">
              ON applies edits immediately. OFF requires manual acceptance.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {isSavingAutoAccept && (
              <Loader2 className="text-muted-foreground size-3 animate-spin" />
            )}
            <Switch
              checked={isAutoAcceptEnabled}
              onCheckedChange={handleAutoAcceptToggle}
              disabled={isSavingAutoAccept}
              size={isMobile ? "default" : "md"}
            />
          </div>
        </div>
      </div>

      {/* Skills Section - auto-save on toggle */}
      <Collapsible
        open={skillsOpen}
        onOpenChange={setSkillsOpen}
        className="border-b"
      >
        <SectionHeader
          title="Skills"
          badge={skills.length || undefined}
          open={skillsOpen}
        />
        <CollapsibleContent>
          <div className="pb-1">
            {isLoadingSkills && skills.length === 0 ? (
              // Blank space during loading for consistent UX (no spinner/text)
              <div className="px-3 py-4" />
            ) : skills.length === 0 ? (
              <div className="text-muted-foreground px-3 py-4 text-center text-sm">
                No skills yet
              </div>
            ) : (
              skills.map((skill) => (
                <SkillRow
                  key={skill.id}
                  skill={skill}
                  onToggle={(enabled) => handleSkillToggle(skill, enabled)}
                  onDelete={() => handleSkillDelete(skill)}
                  isUpdating={updatingSkillId === skill.id}
                  isMobile={isMobile}
                />
              ))
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Tools Section - auto-save on toggle */}
      <Collapsible open={toolsOpen} onOpenChange={setToolsOpen}>
        <SectionHeader title="Tools" open={toolsOpen} />
        <CollapsibleContent>
          <div className="pb-1">
            {/* Document Tools */}
            <Collapsible
              open={documentToolsOpen}
              onOpenChange={setDocumentToolsOpen}
            >
              <SettingsGroupHeader
                title="Document Tools"
                open={documentToolsOpen}
              />
              <CollapsibleContent>
                {documentTools.map((tool) => (
                  <ToolRow
                    key={tool.id}
                    label={tool.label}
                    checked={isToolEnabled(tool.id)}
                    onCheckedChange={(enabled) =>
                      handleToolToggle(tool.id, enabled)
                    }
                    isSaving={savingToolId === tool.id}
                    indent
                    isMobile={isMobile}
                  />
                ))}
              </CollapsibleContent>
            </Collapsible>

            {/* External Tools */}
            <Collapsible
              open={externalToolsOpen}
              onOpenChange={setExternalToolsOpen}
              className="mt-2"
            >
              <SettingsGroupHeader
                title="External Tools"
                open={externalToolsOpen}
              />
              <CollapsibleContent>
                {externalTools.map((tool) => (
                  <ToolRow
                    key={tool.id}
                    label={tool.label}
                    checked={isToolEnabled(tool.id)}
                    onCheckedChange={(enabled) =>
                      handleToolToggle(tool.id, enabled)
                    }
                    isSaving={savingToolId === tool.id}
                    indent
                    isMobile={isMobile}
                  />
                ))}
              </CollapsibleContent>
            </Collapsible>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/**
 * Desktop panel wrapper for project settings.
 * Uses PanelHeader for consistent layout with other panel views.
 */
export function ProjectSettingsPanel({ projectId }: ProjectSettingsPanelProps) {
  const isDocsCollapsed = useUIStore(selectEffectiveRightCollapsed);

  // Title as leading content
  const titleContent = (
    <span className="text-sm font-medium">Project Settings</span>
  );

  // Documents toggle as trailing content
  const trailingContent = (
    <>{isDocsCollapsed && <DocumentsToggle direction="right" />}</>
  );

  return (
    <div className="bg-background text-foreground flex h-full flex-col">
      {/* Scrollable Content - content scrolls into the sticky header */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Header with title and documents toggle - desktop only */}
        {/* Sticky must be on wrapper div, not PanelHeader - CSS sticky requires the
            sticky element to be a direct child of the scrolling container */}
        <div className="bg-background sticky top-0 z-20 hidden md:block">
          <PanelHeader leading={titleContent} trailing={trailingContent} />
        </div>

        <ProjectSettingsPanelContent projectId={projectId} />
      </div>
    </div>
  );
}
