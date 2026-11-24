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
