import { ButtonHTMLAttributes, ReactNode, forwardRef } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

type ToolbarIconButtonVariant = 'default' | 'toggleReadOnly' | 'toggleEdit'

export interface ToolbarIconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof toolbarIconButtonVariants> {
  icon: ReactNode
  isActive?: boolean
  variant?: ToolbarIconButtonVariant
}

const toolbarIconButtonVariants = cva(
  'inline-flex items-center justify-center shrink-0 select-none transition-colors outline-none rounded-sm border border-transparent disabled:opacity-[--opacity-disabled] disabled:pointer-events-none',
  {
    variants: {
      variant: {
        default: 'h-9 w-9 text-muted-foreground hover:border-border hover:bg-[var(--hover)]',
        toggleReadOnly: 'h-9 w-9 text-foreground bg-transparent hover:border-border hover:bg-[var(--hover)]',
        toggleEdit: 'h-9 w-9 text-foreground bg-transparent hover:border-border hover:bg-[var(--hover)]',
      },
      state: {
        active: '',
        inactive: '',
      },
    },
    compoundVariants: [
      {
        variant: 'default',
        state: 'active',
        class: 'border-border bg-card text-foreground',
      },
      {
        variant: 'toggleReadOnly',
        state: 'active',
        class: 'bg-card border-border text-foreground',
      },
      {
        variant: 'toggleEdit',
        state: 'active',
        class: 'bg-transparent border-transparent text-foreground',
      }
    ],
    defaultVariants: {
      variant: 'default',
      state: 'inactive',
    },
  }
)

export const ToolbarIconButton = forwardRef<HTMLButtonElement, ToolbarIconButtonProps>(
  function ToolbarIconButton(
    { icon, isActive = false, variant = 'default', className, disabled, ...props },
    ref
  ) {
    const state = isActive ? 'active' : 'inactive'

    return (
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        className={cn(toolbarIconButtonVariants({ variant, state }), className)}
        {...props}
      >
        {icon}
      </button>
    )
  }
)
