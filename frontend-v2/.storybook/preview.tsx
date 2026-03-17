import type { Preview } from '@storybook/react-vite'
import type { ReactRenderer } from '@storybook/react-vite'
import type { DecoratorFunction } from 'storybook/internal/types'
import React from 'react'
import '../src/index.css'

const withTheme: DecoratorFunction<ReactRenderer> = (Story, context) => {
  const theme = context.globals.theme || 'light'
  return (
    <div className={`${theme === 'dark' ? 'dark' : ''} bg-background text-foreground min-h-screen p-4`}>
      <Story />
    </div>
  )
}

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    a11y: {
      test: 'todo',
    },
  },

  globalTypes: {
    theme: {
      description: 'Theme',
      toolbar: {
        title: 'Theme',
        icon: 'circlehollow',
        items: ['light', 'dark'],
        dynamicTitle: true,
      },
    },
  },

  decorators: [withTheme],
}

export default preview
