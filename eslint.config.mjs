// eslint.config.mjs — the machinery under its own bar (v0.1.5).
// The harness enforces strictTypeChecked + sonarjs/cognitive-complexity <= 15 +
// knip --strict on every consumer; this config holds the enforcement machinery
// itself (installer/, scripts/, tests/, and the shipped gate scripts + hooks —
// linted AS REPO SOURCE, zero consumer surface) to the same complexity bar.
// Ratchet discipline: pre-existing over-budget functions carry an inline
// `eslint-disable-next-line sonarjs/cognitive-complexity -- ratchet(v0.1.5)`
// with today's measured score; reportUnusedDisableDirectives reds a stale one,
// and any NEW over-budget function reds CI. Do not raise the budget.
import js from '@eslint/js'
import sonarjs from 'eslint-plugin-sonarjs'
import globals from 'globals'

export default [
  {
    // template/stack/** is consumer app surface (TS app code + the
    // dependency-free Tauri isolation shim) — the CONSUMER eslint config
    // (template/base/eslint.config.mjs, strictTypeChecked) owns that tree.
    // Everything else that parses as JS in this repo is machinery.
    ignores: ['node_modules/**', 'template/stack/**', '.fixtures/**', 'coverage/**'],
  },
  {
    files: ['**/*.mjs', '**/*.js', '**/*.cjs'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error', // a stale ratchet comment is itself red
    },
    plugins: { sonarjs },
    rules: {
      ...js.configs.recommended.rules,
      // Same budget the consumer config enforces (BUILD-SPEC §Lint).
      'sonarjs/cognitive-complexity': ['error', 15],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
]
