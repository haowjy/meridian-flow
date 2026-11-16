import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { McpToolView } from "@meridian/contracts/mcp";
import { useId, useState } from "react";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { role } from "@/components/ui/roles";
import { Switch } from "@/components/ui/switch";

/**
 * The server's tools as it lists them now, to choose which the AI may use. Until the owner
 * decides how calls with effects are held, only tools the server marks read-only can be chosen;
 * the others are listed once, under the reason.
 */
export function ToolChooser({
  tools,
  initial,
  pending,
  error,
  onSave,
  onCancel,
}: {
  tools: readonly McpToolView[];
  /** The tools chosen when the list opens. */
  initial: ReadonlySet<string>;
  pending: boolean;
  error: string | null;
  onSave: (names: string[]) => void;
  onCancel?: () => void;
}) {
  const [chosen, setChosen] = useState(() => new Set(initial));
  const readable = tools.filter((tool) => tool.readOnly);
  const withEffects = tools.filter((tool) => !tool.readOnly);
  const toggle = (name: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  const names = readable.filter((tool) => chosen.has(tool.name)).map((tool) => tool.name);
  return (
    <div className="space-y-3">
      {tools.length === 0 ? (
        <p className={role.emptyLine}>
          <Trans>This server lists no tools.</Trans>
        </p>
      ) : null}
      {readable.length > 0 ? (
        <ul className="space-y-1">
          {readable.map((tool) => (
            <ToolLine
              key={tool.name}
              tool={tool}
              checked={chosen.has(tool.name)}
              onChange={(on) => toggle(tool.name, on)}
            />
          ))}
        </ul>
      ) : null}
      {withEffects.length > 0 ? (
        <section aria-label={t`Tools that can change things`} className="space-y-1">
          <h4 className={role.subgroupLabel}>
            <Trans>Tools that can change things</Trans>
          </h4>
          <p className="text-xs text-muted-foreground">
            <Trans>For now the AI can use only tools that read.</Trans>
          </p>
          <ul className="space-y-1">
            {withEffects.map((tool) => (
              <ToolLine key={tool.name} tool={tool} checked={false} disabled />
            ))}
          </ul>
        </section>
      ) : null}
      {error ? <InlineErrorRow message={error} className="px-0" /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={pending || names.length === 0}
          aria-busy={pending || undefined}
          onClick={() => onSave(names)}
        >
          {pending ? <Trans>Saving…</Trans> : <Trans>Use these tools</Trans>}
        </Button>
        {onCancel ? (
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
            <Trans>Cancel</Trans>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ToolLine({
  tool,
  checked,
  disabled = false,
  onChange,
}: {
  tool: McpToolView;
  checked: boolean;
  disabled?: boolean;
  onChange?: (on: boolean) => void;
}) {
  const label = useId();
  return (
    <li className="flex items-start justify-between gap-4 rounded-md px-2 py-1.5 hover:bg-ink-fill">
      <div className="min-w-0">
        <div id={label} className="break-all font-mono text-xs text-foreground">
          {tool.name}
        </div>
        {tool.description ? (
          <p className="mt-0.5 line-clamp-3 text-xs text-muted-foreground" title={tool.description}>
            {tool.description}
          </p>
        ) : null}
      </div>
      <Switch
        className="mt-0.5 shrink-0"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-labelledby={label}
      />
    </li>
  );
}
