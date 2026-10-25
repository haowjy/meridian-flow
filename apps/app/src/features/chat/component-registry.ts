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
import type { ComponentType } from "react";
import { HelperResultBlock } from "./HelperResultBlock";

export type { ComponentBlockContent } from "@meridian/contracts/components";

export type ComponentBlockProps = {
  content: ComponentBlockContent;
  invocationResult?: import("@meridian/thread-client").DirectInvocationResult | null;
  threadId?: string;
};

export type ComponentEntry = ComponentType<ComponentBlockProps>;

export const COMPONENT_REGISTRY: Record<string, ComponentEntry> = {
  "helper-result": HelperResultBlock,
};
