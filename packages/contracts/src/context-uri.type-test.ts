/** Compile-time boundary: syntax and DTO values cannot serialize stable Work identity. */

import { canonicalContextUri, type ParsedContextAuthority } from "./context-uri.js";
import type { ResolvedWorkAuthority, WorkAuthorityDto, WorkHandle } from "./works/index.js";

declare const workHandle: WorkHandle;
declare const parsedAuthority: Extract<ParsedContextAuthority, { kind: "work" }>;
declare const dto: WorkAuthorityDto;
declare const resolved: ResolvedWorkAuthority;

// @ts-expect-error raw strings cannot establish stable Work authority
canonicalContextUri("scratch", "notes.md", { kind: "work", workHandle: "drafting" });
// @ts-expect-error a grammar-only WorkHandle is not resolved authority
canonicalContextUri("scratch", "notes.md", { kind: "work", workHandle });
// @ts-expect-error parsed Work syntax is not resolved authority
canonicalContextUri("scratch", "notes.md", parsedAuthority);
// @ts-expect-error JSON DTOs do not grant the opaque server capability
canonicalContextUri("scratch", "notes.md", dto);
canonicalContextUri("scratch", "notes.md", resolved);
