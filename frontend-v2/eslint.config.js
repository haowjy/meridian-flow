// For more info, see https://github.com/storybookjs/eslint-plugin-storybook#configuration-flat-config-format
import storybook from "eslint-plugin-storybook";

import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tailwindcss from 'eslint-plugin-tailwindcss'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([globalIgnores(['dist', 'storybook-static']), {
  files: ['**/*.{ts,tsx}'],
  extends: [
    js.configs.recommended,
    tseslint.configs.recommended,
    reactHooks.configs.flat.recommended,
    reactRefresh.configs.vite,
  ],
  languageOptions: {
    ecmaVersion: 2020,
    globals: globals.browser,
  },
  rules: {
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
  },
}, ...tailwindcss.configs['flat/recommended'], {
  files: ['**/*.{ts,tsx}'],
  settings: {
    tailwindcss: {
      // Tailwind v4 uses different class patterns than v3 —
      // the plugin doesn't fully recognize v4 syntax yet.
      // Whitelist known false positives until upstream catches up.
      whitelist: [
        'border-border/.*',
        'bg-background/.*',
        'bg-foreground/.*',
        'bg-muted/.*',
        'bg-card/.*',
        'bg-accent/.*',
      ],
    },
  },
  rules: {
    // Lint Contract (CI gate, error level) — see AGENTS.md §Lint Contract.
    // Currently warn until pre-existing arbitrary values in feature/ and
    // editor/ code are cleaned up. Graduating to error after cleanup.
    'tailwindcss/no-arbitrary-value': 'warn',
    'tailwindcss/no-custom-classname': 'warn',
  },
}, {
  files: ['**/*.stories.tsx'],
  rules: {
    // Storybook harnesses intentionally wire imperative editor/session APIs
    // into demo UI; React Compiler's ref rule is too strict for that layer.
    'react-hooks/refs': 'off',
  },
}, ...storybook.configs["flat/recommended"]])
