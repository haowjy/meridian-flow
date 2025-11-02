import Link from 'next/link'
import { Card } from './ui/card'
import { cn } from '@/lib/utils'

interface LinkCardProps {
  href: string
  onClick?: () => void
  children: React.ReactNode
  className?: string
}

export function LinkCard({ href, onClick, children, className }: LinkCardProps) {
  const handleClick = () => {
    if (onClick) {
      onClick()
    }
  }

  return (
    <Link
      href={href}
      onClick={handleClick}
      className={cn(
        'block transition-all hover:shadow-lg motion-safe:hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-xl',
        className
      )}
    >
      <Card className="h-full">
        {children}
      </Card>
    </Link>
  )
}
