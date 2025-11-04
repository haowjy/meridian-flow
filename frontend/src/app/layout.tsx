import './globals.css'
import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { Toaster } from '@/shared/components/ui/sonner'
import { PreloadRemover } from '@/core/components/PreloadRemover'
import { SyncProvider } from '@/core/components/SyncProvider'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Meridian',
  description: 'Document management for creative writers',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} preload`}>
        <PreloadRemover />
        <SyncProvider />
        {children}
        <Toaster />
      </body>
    </html>
  )
}
