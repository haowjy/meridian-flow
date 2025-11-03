import './globals.css'
import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import Script from 'next/script'
import { Toaster } from '@/shared/components/ui/sonner'
import { PreloadRemover } from '@/core/components/PreloadRemover'

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
  const panelHydrationScript = `
    (function() {
      try {
        var storage = localStorage.getItem('ui-store');
        var styleEl = document.getElementById('ui-panel-vars');
        if (!styleEl) return;
        
        if (!storage) {
          styleEl.textContent = ':root { --ui-left-width: 25%; --ui-right-width: 0px; }';
          return;
        }
        var parsed = JSON.parse(storage);
        var state = parsed && parsed.state ? parsed.state : {};
        var leftCollapsed = state.leftPanelCollapsed === true;
        var rightCollapsed = state.rightPanelCollapsed === true;
        var leftWidth = leftCollapsed ? '0px' : '25%';
        var rightWidth = rightCollapsed ? '0px' : '25%';
        styleEl.textContent = ':root { --ui-left-width: ' + leftWidth + '; --ui-right-width: ' + rightWidth + '; }';
      } catch (error) {
        console.warn('[ui-panel-init] Failed to sync stored layout state', error);
      }
    })();
  `

  return (
    <html lang="en">
      <head>
        <style id="ui-panel-vars" suppressHydrationWarning dangerouslySetInnerHTML={{ __html: ':root { --ui-left-width: 25%; --ui-right-width: 0px; }' }} />
      </head>
      <body className={`${inter.className} preload`}>
        <Script id="ui-panel-init" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: panelHydrationScript }} />
        <PreloadRemover />
        {children}
        <Toaster />
      </body>
    </html>
  )
}
