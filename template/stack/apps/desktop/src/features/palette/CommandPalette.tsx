import { useState } from 'react'
import { AppDialog } from '../../components/AppDialog'
import { Input } from '../../components/Input'
import { type MessageKey, useI18n } from '../../i18n'
import { cn } from '../../lib/utils'
import { rankCommands } from './fuzzyScore'
import { pushRecent, readRecents } from './recents'

// The typed group union: adding a command with a new section is a deliberate
// one-line extension HERE, and omitting `group` on any command is a compile
// error — no command can ship outside the sectioned rendering.
//
// These are machine IDS, not copy. They used to BE the visible section headers
// ('Navigation' | 'Theme' | ...), which quietly made the type system and the UI
// copy the same thing: renaming a section header was a TYPE change rippling
// through every command definition, and translating one was impossible — the
// header could only ever read in the language its union member was spelled in.
// Splitting them fixes both ends. The id is what the code commits to; the copy
// lives in the catalog under `palette.group.<id>` and is free to change, be
// translated, or be pseudo-localized without touching a single command.
type CommandGroup = 'navigation' | 'theme' | 'view' | 'matrix'

export interface Command {
  readonly id: string
  readonly title: string
  /** Section this command renders under. REQUIRED — see CommandGroup above. */
  readonly group: CommandGroup
  /** Right-aligned context hint (a route path, what the command touches). */
  readonly subtitle?: string
  /**
   * Display-only key hint. Where a command mirrors a keyboard shortcut this
   * MUST be derived from src/keyboard/registry.ts SHORTCUTS (App.tsx does the
   * lookup) — never a hand-typed duplicate that can drift from the registry.
   */
  readonly keys?: string
  readonly run: () => void
}

/**
 * The contextual-command contract: App passes its palette-contribution setter
 * down to the active screen as `registerCommands`; the screen registers its
 * commands in a mount effect and unregisters (`registerCommands([])`) on
 * unmount. Typed props all the way — no global event bus. MatrixScreen →
 * MatrixPanel is the worked pattern.
 */
export type RegisterCommands = (commands: readonly Command[]) => void

interface CommandPaletteProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly commands: readonly Command[]
}

// The pinned-recents section id. Not a CommandGroup: no command declares itself
// 'recents' — the section is synthesized from storage below.
const RECENTS_SECTION = 'recents'

/** Every id a rendered section can carry: a command's home group, or the pinned recents. */
type PaletteSectionId = CommandGroup | typeof RECENTS_SECTION

/** The catalog key for a section header. The template literal is deliberate: the
 *  i18n gate resolves dynamically-built keys by their static prefix, so every
 *  `palette.group.*` message is provably reachable from this one expression. */
function groupLabelKey(id: PaletteSectionId): MessageKey {
  return `palette.group.${id}`
}

interface PaletteSection {
  readonly id: PaletteSectionId
  readonly commands: readonly Command[]
  /** Flat option index of this section's first command — ranking (and the
   *  ArrowUp/Down keyboard model) runs ACROSS sections, not per section. */
  readonly offset: number
}

/** Bucket a (ranked or registration-ordered) list into sections, preserving
 *  order: a group's position is its best (earliest) member's position. */
function groupSections(
  commands: readonly Command[],
): { id: PaletteSectionId; commands: Command[] }[] {
  const sections: { id: PaletteSectionId; commands: Command[] }[] = []
  const byId = new Map<PaletteSectionId, Command[]>()
  for (const command of commands) {
    const bucket = byId.get(command.group)
    if (bucket === undefined) {
      const fresh = [command]
      byId.set(command.group, fresh)
      sections.push({ id: command.group, commands: fresh })
    } else {
      bucket.push(command)
    }
  }
  return sections
}

function withOffsets(
  sections: readonly { id: PaletteSectionId; commands: Command[] }[],
): PaletteSection[] {
  const out: PaletteSection[] = []
  let offset = 0
  for (const section of sections) {
    out.push({ id: section.id, commands: section.commands, offset })
    offset += section.commands.length
  }
  return out
}

// Recents-vs-ranked interplay (the pinned convention): Recents render ONLY on
// the EMPTY query — pinned first, above the grouped full list (a recent command
// also stays in its home group; DOM option ids are flat-index-based, so the
// duplicate is legal). The first typed character replaces the whole surface
// with ranked results — recency never biases ranking, which stays a pure
// deterministic function of (query, commands). Recent ids with no live command
// (a contextual contribution from an unmounted screen) are filtered right here,
// where the live command set is known — storage keeps them for when the
// contributing screen is back.
function buildSections(
  query: string,
  commands: readonly Command[],
  recentIds: readonly string[],
): readonly PaletteSection[] {
  const grouped = groupSections(rankCommands(query, commands))
  if (query !== '') return withOffsets(grouped)
  const byId = new Map(commands.map((command) => [command.id, command]))
  const recents = recentIds.flatMap((id) => {
    const command = byId.get(id)
    return command === undefined ? [] : [command]
  })
  if (recents.length === 0) return withOffsets(grouped)
  return withOffsets([{ id: RECENTS_SECTION, commands: recents }, ...grouped])
}

// Right-aligned hint cell: subtitle then key combo, ink-muted at the app's
// hint density (text-xs), matching the footer/overlay <kbd> treatment.
function HintCell({
  subtitle,
  keys,
}: {
  readonly subtitle: string | undefined
  readonly keys: string | undefined
}) {
  if (subtitle === undefined && keys === undefined) return null
  return (
    <span className="flex shrink-0 items-center gap-2 text-xs text-ink-muted">
      {subtitle !== undefined && <span>{subtitle}</span>}
      {keys !== undefined && (
        <kbd className="rounded border border-edge bg-surface px-1.5 py-0.5 font-mono">{keys}</kbd>
      )}
    </span>
  )
}

interface PaletteOptionProps {
  readonly command: Command
  /** Flat-index DOM id — unique even when a command repeats under Recents. */
  readonly id: string
  readonly active: boolean
  readonly onRun: () => void
}

function PaletteOption({ command, id, active, onRun }: PaletteOptionProps) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      onClick={onRun}
      onKeyDown={(event) => {
        // Options are never tab stops, but anything focusable that runs on
        // click must run on Enter/Space too (jsx-a11y strict).
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onRun()
        }
      }}
      className={cn(
        'flex cursor-pointer items-center justify-between gap-4 rounded px-3 py-2 text-sm',
        active ? 'bg-canvas text-ink' : 'text-ink-muted',
      )}
    >
      <span className="truncate">{command.title}</span>
      <HintCell subtitle={command.subtitle} keys={command.keys} />
    </div>
  )
}

// The mod+k palette. Combobox pattern: the input keeps focus, arrow keys move
// the active option (aria-activedescendant) through the FLAT ranked list —
// straight across section boundaries — Enter runs it, and screen readers track
// the active option without focus ever leaving the text field. Options are
// role=option DIVs (jsx-a11y strict bars interactive roles on li) inside
// role=group sections labelled by their visible headers, with tabIndex -1:
// clickable and programmatically focusable, but never tab stops — the combobox
// input owns keyboard interaction.
// SOURCE: WAI-ARIA APG combobox pattern (listbox popup) [corpus: wcag/character-key-shortcuts]
export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  // Raw persisted ids, read once at mount; every palette-run keeps this in sync
  // via pushRecent's return value, so no render-time storage read can go stale
  // under the React Compiler's memoization.
  const [recentIds, setRecentIds] = useState(readRecents)

  // State resets on CLOSE (not via an open-effect): the palette is always
  // pristine when it reappears, with no cascading setState-in-effect render.
  const handleClose = (): void => {
    setQuery('')
    setActiveIndex(0)
    onClose()
  }

  const sections = buildSections(query, commands, recentIds)
  const flat = sections.flatMap((section) => section.commands)
  const activeFlat = Math.min(activeIndex, flat.length - 1)
  const active = flat[activeFlat]

  const runCommand = (command: Command): void => {
    setRecentIds(pushRecent(command.id))
    handleClose()
    command.run()
  }

  return (
    <AppDialog title={t('palette.title')} open={open} onClose={handleClose}>
      <Input
        role="combobox"
        aria-expanded={flat.length > 0}
        aria-controls="command-palette-options"
        aria-activedescendant={
          active === undefined ? undefined : `palette-option-${String(activeFlat)}`
        }
        aria-label={t('palette.search')}
        placeholder={t('palette.placeholder')}
        data-autofocus
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActiveIndex(0)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setActiveIndex((index) => Math.min(index + 1, flat.length - 1))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActiveIndex((index) => Math.max(index - 1, 0))
          } else if (event.key === 'Enter' && active !== undefined) {
            event.preventDefault()
            runCommand(active)
          }
        }}
      />
      <div
        id="command-palette-options"
        role="listbox"
        aria-label={t('palette.commands')}
        className="mt-2 flex flex-col"
      >
        {sections.map((section) => (
          <div key={section.id} role="group" aria-labelledby={`palette-group-${section.id}`}>
            <div
              role="presentation"
              id={`palette-group-${section.id}`}
              className="px-3 pt-2 pb-1 text-xs font-medium text-ink-muted"
            >
              {t(groupLabelKey(section.id))}
            </div>
            {section.commands.map((command, index) => (
              <PaletteOption
                key={`${section.id}:${command.id}`}
                command={command}
                id={`palette-option-${String(section.offset + index)}`}
                active={section.offset + index === activeFlat}
                onRun={() => {
                  runCommand(command)
                }}
              />
            ))}
          </div>
        ))}
        {flat.length === 0 && (
          <div
            role="option"
            aria-selected={false}
            aria-disabled="true"
            tabIndex={-1}
            className="px-3 py-2 text-sm text-ink-muted"
          >
            {t('palette.empty')}
          </div>
        )}
      </div>
    </AppDialog>
  )
}
