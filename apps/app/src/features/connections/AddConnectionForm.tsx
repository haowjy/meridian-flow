import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { MCP_NAME_MAX_LENGTH, type McpConnectionLevel } from "@meridian/contracts/mcp";
import { type ReactNode, useId } from "react";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { suggestedName } from "./connection-status";

export type AddValues = {
  url: string;
  /** Null while it follows the address. */
  name: string | null;
  token: string;
  level: McpConnectionLevel;
};

/** Why an add failed, shown under the address when the server refused it, else under the form. */
export type AddError = { on: "address" | "form"; message: string };

export const EMPTY_ADD: AddValues = { url: "", name: null, token: "", level: "account" };

export const addName = (values: AddValues) => values.name ?? suggestedName(values.url);

export function levelLabel(level: McpConnectionLevel): string {
  return level === "account" ? t`All my projects` : t`This project`;
}

/**
 * Adding a connection: its address, a name the AI calls it by, an optional token, and, inside a
 * project, which level it goes on. The one place Flow says what a server can do with the AI.
 */
export function AddConnectionForm({
  values,
  inProject,
  error,
  onChange,
  onSubmit,
  onCancel,
}: {
  values: AddValues;
  inProject: boolean;
  error: AddError | null;
  onChange: (values: AddValues) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const ids = {
    url: useId(),
    urlError: useId(),
    name: useId(),
    token: useId(),
    level: useId(),
  };
  const addressError = error?.on === "address" ? error.message : null;
  const name = addName(values);
  return (
    <form
      aria-label={t`Add a connection`}
      className="space-y-3 rounded-lg border border-border-subtle p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (values.url.trim() && name) onSubmit();
      }}
    >
      <Field id={ids.url} label={<Trans>Address</Trans>}>
        <Input
          id={ids.url}
          type="url"
          required
          autoFocus
          spellCheck={false}
          autoComplete="off"
          placeholder="https://example.com/mcp"
          value={values.url}
          onChange={(event) => onChange({ ...values, url: event.target.value })}
          aria-invalid={addressError ? true : undefined}
          aria-describedby={addressError ? ids.urlError : undefined}
        />
        {addressError ? (
          <InlineErrorRow id={ids.urlError} message={addressError} className="px-0" />
        ) : null}
      </Field>
      <Field id={ids.name} label={<Trans>Name</Trans>}>
        <Input
          id={ids.name}
          required
          spellCheck={false}
          autoComplete="off"
          maxLength={MCP_NAME_MAX_LENGTH}
          pattern="[A-Za-z0-9_\-]+"
          title={t`Letters, digits, - or _, with no spaces.`}
          value={name}
          onChange={(event) => onChange({ ...values, name: event.target.value })}
        />
      </Field>
      <Field id={ids.token} label={<Trans>Token</Trans>} optional>
        <Input
          id={ids.token}
          type="password"
          autoComplete="off"
          value={values.token}
          onChange={(event) => onChange({ ...values, token: event.target.value })}
        />
      </Field>
      {inProject ? (
        <Field id={ids.level} label={<Trans>Use in</Trans>}>
          <Select
            value={values.level}
            onValueChange={(level) => onChange({ ...values, level: level as McpConnectionLevel })}
          >
            <SelectTrigger id={ids.level} className="focus-ring w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="account">{levelLabel("account")}</SelectItem>
              <SelectItem value="project">{levelLabel("project")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      {error?.on === "form" ? <InlineErrorRow message={error.message} className="px-0" /> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm">
          <Trans>Connect</Trans>
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  optional = false,
  children,
}: {
  id: string;
  label: ReactNode;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="flex items-baseline gap-1.5 text-sm font-medium">
        {label}
        {optional ? (
          <span className="text-xs font-normal text-muted-foreground">
            <Trans>(if the server asks for one)</Trans>
          </span>
        ) : null}
      </label>
      {children}
    </div>
  );
}
