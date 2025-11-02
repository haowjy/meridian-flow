import { Label } from './ui/label'
import { cn } from '@/lib/utils'
import React from 'react'

interface FieldProps {
  label: string
  id: string
  error?: string
  required?: boolean
  children: React.ReactElement
  className?: string
}

export function Field({ label, id, error, required, children, className }: FieldProps) {
  const errorId = `${id}-error`

  // Clone the child element and add aria attributes
  const enhancedChild = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<any>, {
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': error ? errorId : undefined,
      })
    : children

  return (
    <div className={cn('grid gap-2', className)}>
      <Label htmlFor={id}>
        {label}
        {required && <span className="text-destructive ml-1">*</span>}
      </Label>
      {enhancedChild}
      {error && (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
