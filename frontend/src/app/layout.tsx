import './globals.css'
import type { Metadata } from 'next'
import { Literata } from 'next/font/google'
import { Inter } from 'next/font/google'
import { Toaster } from '@/shared/components/ui/sonner'
import { PreloadRemover } from '@/core/components/PreloadRemover'
import { SyncProvider } from '@/core/components/SyncProvider'
import { DevRetryPanel } from '@/core/components/DevRetryPanel'

// Literata - Primary serif font for long-form reading, editor, chat messages
const literata = Literata({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-literata',
  display: 'swap',
})

// Inter - Secondary sans-serif for UI elements, buttons, controls
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-inter',
  display: 'swap',
})


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
    <html lang="en" className={`${inter.variable} ${literata.variable}`}>
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
