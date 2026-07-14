// The message catalog — the ONE place user-facing copy lives.
//
// Every string the UI shows is a key here. That is not a style preference: a literal in a
// component is a string no translator can reach, no reviewer can find, and no gate can see.
// The i18n gate (tools/check-i18n.mjs) reds on a hardcoded user-facing literal anywhere under
// apps/desktop/src, and the e2e pseudo-locale lane proves it behaviourally — under `en-XA`
// every catalog string is visibly mangled, so any plain-English text still on screen is, by
// construction, a string that bypassed this file.
//
// SHAPE. A message is either a plain string or a plural set keyed by CLDR category. `t()`
// picks the category with Intl.PluralRules for the ACTIVE locale, so "1 row" / "2 rows" is
// the language's rule, not English's — a language with a dual or a paucal form gets its own
// branch by adding the key, with no code change.
//
// PLACEHOLDERS are `{name}`. Numbers interpolated through them are formatted with
// Intl.NumberFormat, so a thousands separator is the locale's, not a hardcoded comma.
// SOURCE: Unicode CLDR plural rules — the categories Intl.PluralRules selects between
// https://cldr.unicode.org/index/cldr-spec/plural-rules [corpus: harness/doctrine]

/** A plural set. `other` is required — it is the fallback for every category a locale lacks. */
interface PluralMessage {
  readonly zero?: string
  readonly one?: string
  readonly two?: string
  readonly few?: string
  readonly many?: string
  readonly other: string
}

export type Message = string | PluralMessage

export const en = {
  // ---- shell ------------------------------------------------------------------
  'nav.primary': 'Primary',
  'route.home': 'Home',
  'route.matrix': 'Matrix',

  // ---- theme ------------------------------------------------------------------
  'theme.system': 'Auto',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  // The old aria-label interpolated the raw enum token ("Switch to system theme").
  'theme.switch.system': 'Switch to the automatic theme',
  'theme.switch.light': 'Switch to the light theme',
  'theme.switch.dark': 'Switch to the dark theme',
  'theme.toast.system': 'Theme: auto',
  'theme.toast.light': 'Theme: light',
  'theme.toast.dark': 'Theme: dark',

  // ---- language ---------------------------------------------------------------
  // An i18n seam with no way to change language is a seam nobody can exercise — including
  // the people who would have to notice it was broken.
  'locale.switch': 'Switch to {language}',
  'locale.en': 'English',
  'locale.en-XA': 'Pseudo',
  'locale.ar-XB': 'Pseudo RTL',

  // ---- command palette --------------------------------------------------------
  'palette.title': 'Command palette',
  'palette.search': 'Search commands',
  'palette.placeholder': 'Type a command…',
  'palette.commands': 'Commands',
  'palette.empty': 'No matching command',
  // The CommandGroup union used to BE the visible headers — machine ids now, copy here.
  'palette.group.recents': 'Recents',
  'palette.group.navigation': 'Navigation',
  'palette.group.theme': 'Theme',
  'palette.group.view': 'View',
  'palette.group.matrix': 'Matrix',

  // ---- commands ---------------------------------------------------------------
  'command.goTo': 'Go to {label}',
  'command.theme.light': 'Use light theme',
  'command.theme.dark': 'Use dark theme',
  'command.shortcuts': 'Show keyboard shortcuts',
  'command.probe': 'Probe API connection now',
  'command.matrix.top': 'Jump to top',
  'command.matrix.top.subtitle': 'First cell',
  'command.matrix.reload': 'Reload matrix rows',
  'command.matrix.reload.subtitle': 'From page one',

  // ---- shortcuts --------------------------------------------------------------
  'shortcuts.title': 'Keyboard shortcuts',
  'shortcut.command-palette': 'Command palette',
  'shortcut.show-shortcuts': 'Keyboard shortcuts',

  // ---- common -----------------------------------------------------------------
  'common.retry': 'Retry',
  'common.reload': 'Reload',
  'common.loading': 'Loading…',
  'common.close': 'Esc',
  'common.dismiss': 'Dismiss notification',

  // ---- connection -------------------------------------------------------------
  'connection.connecting': 'Connecting to API…',
  'connection.connected': 'API connected (v{version})',
  'connection.unreachable': 'API unreachable — retrying',

  // ---- notes ------------------------------------------------------------------
  'notes.heading': 'Notes',
  'notes.error.title': 'Could not load notes.',
  'notes.empty.title': 'No notes yet',
  'notes.empty.description': 'The first note you create will appear here.',
  'notes.composer.label': 'Add a note',
  'notes.composer.placeholder': 'Note title',
  'notes.composer.submit': 'Add note',
  'notes.composer.pending': 'Adding…',
  'notes.composer.invalid': 'Enter a title between 1 and {max} characters.',
  'notes.createdAt': 'Created {when}',

  // ---- matrix -----------------------------------------------------------------
  'matrix.heading': 'Matrix',
  'matrix.grid': 'Notes matrix',
  'matrix.error.title': 'Could not load the matrix.',
  'matrix.empty.title': 'No rows to chart yet',
  'matrix.empty.description':
    'Once notes exist, their numeric columns appear here as a dense, virtualized matrix.',
  'matrix.loadMore': 'Load more',
  'matrix.loadingMore': 'Loading…',
  'matrix.loadMore.failed': 'Loading more failed.',
  'matrix.loadMore.toast': 'Could not load more rows: {message}',
  // Plural on the ROW count — "1 rows" was hardcoded before.
  'matrix.summary': {
    one: '{rows} row × {columns} columns, virtualized.',
    other: '{rows} rows × {columns} columns, virtualized.',
  },
  'matrix.summary.aria': {
    one: 'Distribution of {column} across {rows} row',
    other: 'Distribution of {column} across {rows} rows',
  },
  'matrix.column.note': 'Note',
  'matrix.column.confidence': 'Confidence',
  'matrix.column.title': 'Title length',
  'matrix.column.body': 'Body length',
  'matrix.column.words': 'Words',
  'matrix.column.lines': 'Lines',
  'matrix.column.day': 'Day',
  'matrix.column.value': 'value',
  'matrix.row': 'Row {n}',

  // ---- home -------------------------------------------------------------------
  'home.title': 'Ready to build',
  'home.body':
    'This shell wires the stack end to end: typed IPC bindings, the API health probe, a command palette, and a WCAG-safe keyboard-shortcut registry. Replace this card with your first screen.',
  'home.host': 'Tauri host v{version}',
  'home.noHost': 'Running outside the Tauri host',

  // ---- errors -----------------------------------------------------------------
  'error.title': 'Something went wrong',
  'error.body': 'An unexpected error occurred while rendering this screen.',
  // The server's error envelope carries a stable `code` — THAT is what the client
  // localizes. The server's English `message` is a developer detail (and a support
  // reference), never the thing a user is asked to read.
  'error.api.bad_request': 'That request was not valid.',
  'error.api.unauthorized': 'You are not signed in.',
  'error.api.not_found': 'That item no longer exists.',
  'error.api.payload_too_large': 'That is too large to send.',
  'error.api.version_skew': 'This app is out of date — restart to update.',
  'error.api.internal': 'Something went wrong on the server.',
  'error.api.unknown': 'The request failed ({status}).',
  'error.api.offline': 'Could not reach the server.',
  'error.reference': 'Reference {id}',
} as const satisfies Record<string, Message>

export type MessageKey = keyof typeof en
export type Catalog = Readonly<Record<MessageKey, Message>>
