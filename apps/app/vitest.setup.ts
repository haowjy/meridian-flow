/** Test-environment repairs that must run before any suite touches the DOM. */
import { createElement, Fragment, type ReactNode } from "react";
import { vi } from "vitest";
import { installJsdomLayoutFallbacks } from "./src/test-support/jsdom-layout";

const join = (parts: TemplateStringsArray, ...values: unknown[]) =>
  parts.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, "");

vi.mock("@lingui/core/macro", () => ({
  t: join,
  msg: (parts: TemplateStringsArray, ...values: unknown[]) => {
    const message = join(parts, ...values);
    return { id: message, message };
  },
  plural: (count: number, forms: { one?: string; other: string }) =>
    (count === 1 ? (forms.one ?? forms.other) : forms.other).replace("#", String(count)),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children),
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));

installJsdomLayoutFallbacks();
