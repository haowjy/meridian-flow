// @ts-nocheck
/**
 * Tool registry: holds executable tool registrations and exposes lookup plus
 * the FunctionTool[] schema for the gateway. Owns the name->handler/schema
 * mapping; depends only on the tool types.
 *
 * ── Design ──
 *
 * The registry is a simple `Map<string, ToolRegistration>` keyed by tool name.
 * There is no hierarchical namespace, no aliasing, and no tool-group concept —
 * every tool has one canonical name and the model references it directly.
 *
 * Registration is additive: calling `register` with an existing name throws.
 * A duplicate registration means two execution sources disagree about which
 * handler/schema owns a model-visible name, so the collision must be resolved
 * at the caller rather than hidden by last-writer-wins behavior.
 *
 * ── Publication boundary ──
 *
 * `getDefinitions()` is the registry-wide default model-visible tool set. It is
 * derived only from server-executable registrations already handed to the registry
 * whose registration does not opt out with `advertise: false`, and
 * `core-tools.ts` requires concrete handlers before core registrations exist.
 * There is no registry path that turns a schema-only placeholder or unhandled
 * client registration into an advertised tool.
 */
import type { FunctionTool } from "../gateway/index.js";

import type { ToolRegistration, ToolRegistry } from "./types.js";

export interface CreateToolRegistryOptions {
  registrations?: ToolRegistration[];
}

export function createToolRegistry(options: CreateToolRegistryOptions = {}): ToolRegistry {
  const registrations = new Map<string, ToolRegistration>();

  function addRegistration(registration: ToolRegistration): void {
    const name = registration.definition.name;
    if (registrations.has(name)) {
      throw new Error(`Tool registration already exists for name: ${name}`);
    }
    registrations.set(name, registration);
  }

  for (const registration of options.registrations ?? []) {
    addRegistration(registration);
  }

  return {
    register(registration: ToolRegistration): void {
      addRegistration(registration);
    },

    getDefinitions(): FunctionTool[] {
      // The gateway only consumes FunctionTool definitions (not HostedTool),
      // and client-side dispatch is not implemented yet, so the advertised
      // set is server-executable function registrations only.
      return [...registrations.values()]
        .filter(
          (registration) =>
            registration.execution.type === "server" && registration.advertise !== false,
        )
        .map((registration) => registration.definition);
    },

    getRegistration(name: string): ToolRegistration | undefined {
      return registrations.get(name);
    },
  };
}
