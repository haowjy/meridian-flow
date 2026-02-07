/**
 * Tool Renderer Registry
 *
 * Extensible registry for custom tool UI components.
 * Follows the same pattern as registry.ts for block types.
 *
 * SOLID Benefits:
 * - Open/Closed: Add new tool UIs without modifying AssistantTurn
 * - Single Responsibility: Each tool block handles its own rendering
 * - Dependency Inversion: AssistantTurn depends on registry abstraction
 *
 * To add a new custom tool UI:
 * 1. Create your component in blocks/YourToolBlock/
 * 2. Register it here: TOOL_RENDERERS['your_tool'] = ...
 *
 * Unregistered tools fall back to generic ToolInteractionBlock.
 */

import React from "react";
import type { TurnBlock } from "@/features/threads/types";
import { ToolInteractionBlock } from "./ToolInteractionBlock";
import { TextEditorBlock } from "./TextEditorBlock";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Tool renderer function type.
 * Receives paired tool_use and tool_result blocks.
 */
export type ToolRendererFn = (
  toolUse: TurnBlock | null,
  toolResult: TurnBlock | null,
) => React.ReactElement;

// =============================================================================
// REGISTRY
// =============================================================================

/**
 * Registry of tool name to custom renderer.
 *
 * Pattern:
 * - Key: tool name from backend (e.g., 'str_replace_based_edit_tool')
 * - Value: Function that creates the component
 *
 * All document operations use str_replace_based_edit_tool, rendered by TextEditorBlock.
 */
const TOOL_RENDERERS: Record<string, ToolRendererFn> = {
  // Unified text editor tool (matches Anthropic's text_editor_20250728)
  // Handles view (documents + folders), str_replace, create, insert
  str_replace_based_edit_tool: (toolUse, toolResult) =>
    React.createElement(TextEditorBlock, { toolUse, toolResult }),

  // Future custom tool UIs can be registered here:
  // web_search: (toolUse, toolResult) =>
  //   React.createElement(WebSearchBlock, { toolUse, toolResult }),
};

/**
 * Default renderer for unregistered tools.
 * Uses generic ToolInteractionBlock with JSON display.
 */
const DEFAULT_RENDERER: ToolRendererFn = (toolUse, toolResult) =>
  React.createElement(ToolInteractionBlock, { toolUse, toolResult });

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Get the renderer function for a given tool name.
 * Returns default ToolInteractionBlock renderer for unknown tools.
 *
 * @param toolName - Tool name from tool_use/tool_result content
 * @returns Renderer function for the tool
 */
export function getToolRenderer(toolName: string | null): ToolRendererFn {
  if (toolName && TOOL_RENDERERS[toolName]) {
    return TOOL_RENDERERS[toolName];
  }
  return DEFAULT_RENDERER;
}

/**
 * Register a custom tool renderer at runtime.
 * Useful for plugins or dynamically loaded tool UIs.
 *
 * @example
 * ```ts
 * registerToolRenderer('my_tool', (toolUse, toolResult) =>
 *   React.createElement(MyToolBlock, { toolUse, toolResult })
 * )
 * ```
 */
export function registerToolRenderer(
  toolName: string,
  renderer: ToolRendererFn,
): void {
  TOOL_RENDERERS[toolName] = renderer;
}

/**
 * Get all registered tool names.
 * Useful for debugging or listing available custom tool UIs.
 */
export function getRegisteredToolNames(): string[] {
  return Object.keys(TOOL_RENDERERS);
}
