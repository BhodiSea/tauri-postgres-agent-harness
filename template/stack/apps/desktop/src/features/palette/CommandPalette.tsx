import { useState } from 'react'
import { AppDialog } from '../../components/AppDialog'
import { Input } from '../../components/Input'
import { cn } from '../../lib/utils'

export interface Command {
  readonly id: string
  readonly title: string
  readonly run: () => void
}

interface CommandPaletteProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly commands: readonly Command[]
}

// The mod+k palette. Combobox pattern: the input keeps focus, arrow keys move
// the active option (aria-activedescendant), Enter runs it — screen readers
// track the active option without focus ever leaving the text field. Options
// are role=option DIVs (jsx-a11y strict bars interactive roles on li) with
// tabIndex -1: clickable and programmatically focusable, but never tab stops —
// the combobox input owns keyboard interaction.
// SOURCE: WAI-ARIA APG combobox pattern (listbox popup) [corpus: wcag/character-key-shortcuts]
export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  // State resets on CLOSE (not via an open-effect): the palette is always
  // pristine when it reappears, with no cascading setState-in-effect render.
  const handleClose = (): void => {
    setQuery('')
    setActiveIndex(0)
    onClose()
  }

  const filtered = commands.filter((command) =>
    command.title.toLowerCase().includes(query.toLowerCase()),
  )
  const active = filtered[Math.min(activeIndex, filtered.length - 1)]

  const runCommand = (command: Command): void => {
    handleClose()
    command.run()
  }

  return (
    <AppDialog title="Command palette" open={open} onClose={handleClose}>
      <Input
        role="combobox"
        aria-expanded={filtered.length > 0}
        aria-controls="command-palette-options"
        aria-activedescendant={active === undefined ? undefined : `command-${active.id}`}
        aria-label="Search commands"
        placeholder="Type a command…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActiveIndex(0)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setActiveIndex((index) => Math.min(index + 1, filtered.length - 1))
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
        aria-label="Commands"
        className="mt-2 flex flex-col"
      >
        {filtered.map((command) => (
          <div
            key={command.id}
            id={`command-${command.id}`}
            role="option"
            aria-selected={command.id === active?.id}
            tabIndex={-1}
            onClick={() => {
              runCommand(command)
            }}
            onKeyDown={(event) => {
              // Options are never tab stops, but anything focusable that runs on
              // click must run on Enter/Space too (jsx-a11y strict).
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                runCommand(command)
              }
            }}
            className={cn(
              'cursor-pointer rounded px-3 py-2 text-sm',
              command.id === active?.id ? 'bg-canvas text-ink' : 'text-ink-muted',
            )}
          >
            {command.title}
          </div>
        ))}
        {filtered.length === 0 && (
          <div
            role="option"
            aria-selected={false}
            aria-disabled="true"
            tabIndex={-1}
            className="px-3 py-2 text-sm text-ink-muted"
          >
            No matching command
          </div>
        )}
      </div>
    </AppDialog>
  )
}
