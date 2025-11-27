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
        'block cursor-pointer rounded-lg transition-transform motion-safe:hover:scale-[1.02]',
        className
      )}
    >
      <Card className="h-full">
        {children}
      </Card>
    </Link>
  )
}
