import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Label } from "./label"

/**
 * EditorForm - Reusable form components for editor/workspace contexts.
 *
 * These components use an "editorial inset" style that creates depth through
 * inner shadows and subtle backgrounds, making form fields feel "pressed into"
 * the warm paper background. This maintains the literary aesthetic while
 * providing clear visual definition.
 *
 * Components:
 * - EditorFormField: Wrapper with editorial label + hint support
 * - EditorFormInput: Inset well input (subtle bg, inner shadow, optional left accent)
 * - EditorFormTextarea: Inset well textarea (subtle bg, inner shadow)
 * - EditorFormSection: Visual grouping for related fields
 *
 * Usage:
 * <EditorFormField label="Command Name" htmlFor="name" hint="Lowercase, no spaces">
 *   <EditorFormInput id="name" value={name} onChange={...} />
 * </EditorFormField>
 */

// =============================================================================
// EditorFormSection
// =============================================================================

interface EditorFormSectionProps {
  /** Optional title displayed above the section */
  title?: string
  className?: string
  children: React.ReactNode
}

/**
 * Visual grouping for related form fields.
 * Creates a subtle card-like container with optional title.
 */
function EditorFormSection({
  title,
  className,
  children,
}: EditorFormSectionProps) {
  return (
    <div className={cn("space-y-4", className)}>
      {title && (
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
      )}
      {children}
    </div>
  )
}

// =============================================================================
// EditorFormField
// =============================================================================

interface EditorFormFieldProps {
  /** Label text displayed above the input */
  label: string
  /** ID of the input element for label association */
  htmlFor: string
  /** Optional hint text displayed below the label */
  hint?: string
  /** Optional validation error message */
  error?: string
  /** Optional leading element (e.g., "/" prefix for commands) */
  leading?: React.ReactNode
  className?: string
  children: React.ReactNode
}

/**
 * Field wrapper with editorial-style label and optional hint/leading content.
 */
function EditorFormField({
  label,
  htmlFor,
  hint,
  error,
  leading,
  className,
  children,
}: EditorFormFieldProps) {
  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-baseline gap-1">
        <Label htmlFor={htmlFor} variant="editorial">
          {label}
        </Label>
        {/* Always render span to prevent vertical shift - invisible when no content */}
        <span className={cn(
          "text-xs",
          error ? "text-destructive" : hint ? "text-muted-foreground/70" : "invisible"
        )}>
          {error || hint || '\u00A0'}
        </span>
      </div>
      {leading ? (
        <div className="flex items-center gap-2">
          {leading}
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  )
}

// =============================================================================
// EditorFormInput
// =============================================================================

const editorInputVariants = cva(
  // Base styles: inset well (same as textarea for visual consistency)
  "w-full min-w-0 placeholder:text-muted-foreground " +
    "border border-editor-input-border rounded-md " +
    "px-3 py-2 text-base transition-all outline-none " +
    "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-[--opacity-disabled] " +
    "md:text-sm font-sans " +
    // Hover: subtle border enhancement
    "hover:border-primary/30 " +
    // Focus: primary border
    "focus-visible:border-primary focus-visible:outline-none",
  {
    variants: {
      size: {
        default: "h-[var(--component-height-md)]", // 36px
        sm: "h-[var(--component-height-sm)]", // 32px
        lg: "h-[var(--component-height-lg)]", // 40px
        xl: "h-10 text-xl md:text-lg", // Larger for prominent fields (command name)
      },
      accent: {
        none: "",
        left: "border-l-[3px] border-l-primary", // Sage left accent for hero fields
      },
      state: {
        default: "",
        error: "border-destructive hover:border-destructive focus-visible:border-destructive",
      },
    },
    defaultVariants: {
      size: "default",
      accent: "none",
      state: "default",
    },
  }
)

interface EditorFormInputProps
  extends Omit<React.ComponentProps<"input">, "size">,
    VariantProps<typeof editorInputVariants> {}

/**
 * Inset well input for editor contexts.
 * Uses bg-card background with inner shadow for "pressed in" depth effect.
 * Optional left accent border for hero fields.
 */
const EditorFormInput = React.forwardRef<HTMLInputElement, EditorFormInputProps>(
  ({ className, size, accent, state, type, ...props }, ref) => {
    return (
      <input
        ref={ref}
        type={type}
        data-slot="editor-input"
        className={cn("bg-card", editorInputVariants({ size, accent, state, className }))}
        style={{
          // Inset shadow for depth (well effect)
          boxShadow: 'var(--editor-inset-shadow)',
        }}
        {...props}
      />
    )
  }
)
EditorFormInput.displayName = 'EditorFormInput'

// =============================================================================
// EditorFormTextarea
// =============================================================================

interface EditorFormTextareaProps extends React.ComponentProps<"textarea"> {
  state?: 'default' | 'error'
}

/**
 * Inset well textarea for editor contexts.
 * Uses bg-card background with inner shadow for "pressed in" depth effect.
 * Focus state adds sage border accent for visual hierarchy.
 */
function EditorFormTextarea({
  className,
  state = 'default',
  ...props
}: EditorFormTextareaProps) {
  return (
    <textarea
      data-slot="editor-textarea"
      className={cn(
        // Base styles: inset well effect with bg-card background
        "w-full min-w-0 placeholder:text-muted-foreground bg-card",
        "border border-editor-input-border rounded-md",
        "px-3 py-2 text-base transition-all outline-none",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-[--opacity-disabled]",
        "md:text-sm font-sans resize-none",
        // Hover: subtle border enhancement
        "hover:border-primary/30",
        // Focus: primary border (green/sage highlight)
        "focus-visible:border-primary focus-visible:outline-none",
        // Error state
        state === 'error' && "border-destructive hover:border-destructive focus-visible:border-destructive",
        className
      )}
      style={{
        // Inset shadow for depth (well effect)
        boxShadow: 'var(--editor-inset-shadow)',
      }}
      {...props}
    />
  )
}

export { EditorFormField, EditorFormInput, EditorFormTextarea, EditorFormSection }
