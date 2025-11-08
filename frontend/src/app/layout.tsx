import './globals.css'
import type { Metadata } from 'next'
import { Toaster } from '@/shared/components/ui/sonner'
import { PreloadRemover } from '@/core/components/PreloadRemover'
import { SyncProvider } from '@/core/components/SyncProvider'
import { DevRetryPanel } from '@/core/components/DevRetryPanel'


export const metadata: Metadata = {
  title: 'Meridian',
  description: 'File management for creative writers',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={`font-sans preload`}>
        <PreloadRemover />
        <SyncProvider />
        {children}
        <Toaster />
        {process.env.NEXT_PUBLIC_DEV_TOOLS === '1' ? <DevRetryPanel /> : null}
      </body>
    </html>
  )
}
