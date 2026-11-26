import type * as React from "react";
import { useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/utils";

const fieldReset =
  "m-0 min-w-0 border-0 bg-transparent p-0 outline-none [color:inherit] [font:inherit] [letter-spacing:inherit] placeholder:text-muted-foreground disabled:opacity-60";

export function InlineEditInput({
  className,
  value,
  placeholder,
  ...props
}: Omit<React.ComponentProps<"input">, "value"> & { value: string }) {
  return (
    <span className={cn("inline-edit-field inline-grid min-w-[1ch] max-w-full", className)}>
      {/* Invisible twin that gives the grid cell the text's width. */}
      <span
        aria-hidden
        className="invisible col-start-1 row-start-1 overflow-hidden pr-px whitespace-pre"
      >
        {value || placeholder || " "}
      </span>
      <input
        type="text"
        data-handles-escape=""
        size={1}
        value={value}
        placeholder={placeholder}
        {...props}
        // Zero width with a full min-width: the twin alone sizes the cell; the
        // input contributes nothing (a text input is ~3ch wide by default).
        className={cn(fieldReset, "col-start-1 row-start-1 w-0 min-w-full")}
      />
    </span>
  );
}

export function InlineEditTextarea({
  className,
  value,
  ref,
  ...props
}: Omit<React.ComponentProps<"textarea">, "value"> & { value: string }) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  // Height follows content so the field is exactly as tall as the resting text.
  useLayoutEffect(() => {
    const node = own.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${node.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      data-handles-escape=""
      rows={1}
      value={value}
      {...props}
      ref={(node) => {
        own.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      className={cn(
        fieldReset,
        "inline-edit-field block w-full resize-none overflow-hidden whitespace-pre-wrap",
        className,
      )}
    />
  );
}
