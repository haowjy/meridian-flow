/**
 * component-registry — custom chat block registry and prop contract.
 *
 * Purpose: Defines the frontend seam that maps `blockType: "custom"`
 * payloads to React components by `content.kind`. Adding a interrupt kind
 * stays one component file plus one entry in `COMPONENT_REGISTRY`.
 * Key decision: the registry is deliberately lean — a kind maps directly to a
 * component. Component-block content and interrupt answer contracts live in
 * `@meridian/contracts/components`, so the client does not grow a parallel
 * schema.
 */
import type { ComponentBlockContent } from "@meridian/contracts/components";
import type { JsonValue } from "@meridian/contracts/threads";
import type { ComponentType } from "react";

import { ChoiceBlock } from "./ChoiceBlock";
import { FormBlock } from "./FormBlock";
import { HelperResultBlock } from "./HelperResultBlock";
import { TextBlock } from "./TextBlock";

export type { ComponentBlockContent } from "@meridian/contracts/components";

export type ComponentBlockProps = {
  content: ComponentBlockContent;
  respond: (value: JsonValue) => void;
  isAwaitingResponse: boolean;
};

export type ComponentEntry = ComponentType<ComponentBlockProps>;

export const COMPONENT_REGISTRY: Record<string, ComponentEntry> = {
  choice: ChoiceBlock,
  "free-text": TextBlock,
  form: FormBlock,
  "helper-result": HelperResultBlock,
};
