// @ts-nocheck
/**
 * component-registry — custom chat block registry and prop contract.
 *
 * Purpose: Defines the frontend seam that maps `blockType: "custom"`
 * payloads to React components by `content.kind`. Adding a checkpoint kind
 * stays one component file plus one entry in `COMPONENT_REGISTRY`.
 * Key decision: the registry is deliberately lean — a kind maps directly to a
 * component. Component-block content and checkpoint answer contracts live in
 * `@meridian/contracts/components`, so the client does not grow a parallel
 * schema.
 */
import type { ComponentBlockContent } from "@meridian/contracts/components";
import type { JsonValue } from "@meridian/contracts/threads";
import type { ComponentType } from "react";

import { Checkpoint } from "./Checkpoint";
import { ChoiceCheckpoint } from "./ChoiceCheckpoint";
import { FreeTextCheckpoint } from "./FreeTextCheckpoint";

export type { ComponentBlockContent } from "@meridian/contracts/components";

export type ComponentBlockProps = {
  content: ComponentBlockContent;
  respond: (value: JsonValue) => void;
  isAwaitingResponse: boolean;
};

export type ComponentEntry = ComponentType<ComponentBlockProps>;

export const COMPONENT_REGISTRY: Record<string, ComponentEntry> = {
  choice: ChoiceCheckpoint,
  "free-text": FreeTextCheckpoint,
  checkpoint: Checkpoint,
};
