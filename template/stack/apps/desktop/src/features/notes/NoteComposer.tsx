import { useState } from 'react'
import { Button } from '../../components/Button'
import { Field } from '../../components/Field'
import { Input } from '../../components/Input'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/utils'
import type { CreateNoteStatus, SubmitOutcome } from './useCreateNote'

// The write form of the optimistic create-note slice — pure presentation over
// useCreateNote's state (NotesPanel owns the hook so the optimistic rows land
// in ITS list). Everything renders through primitives: Field wires the aria
// contract, Input + Button carry the tokens. While the POST is in flight the
// submit affordance disables, relabels to t('notes.composer.pending') — "Adding…"
// in English, visible under reduced motion — and pulses only behind motion-safe:.
// The relabel is the accessible name, so it must stay catalog copy: a screen
// reader announces the pending state by reading it.

interface NoteComposerProps {
  readonly status: CreateNoteStatus
  /** Inline contract-validation message, rendered through Field's error line. */
  readonly fieldError: string | null
  readonly onSubmit: (input: { readonly title: string }) => Promise<SubmitOutcome>
}

export function NoteComposer({ status, fieldError, onSubmit }: NoteComposerProps) {
  const [title, setTitle] = useState('')
  const { t } = useI18n()
  const pending = status === 'pending'

  const submit = async (): Promise<void> => {
    const outcome = await onSubmit({ title })
    // Optimistic-UX contract: the draft clears only once the note reconciled;
    // a rollback keeps the text so the user retries without retyping.
    if (outcome === 'settled') setTitle('')
  }

  return (
    <form
      data-testid="note-composer"
      className="mt-4"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <Field label={t('notes.composer.label')} error={fieldError ?? undefined}>
        {(control) => (
          <div className="flex items-center gap-2">
            <Input
              {...control}
              value={title}
              placeholder={t('notes.composer.placeholder')}
              disabled={pending}
              onChange={(event) => {
                setTitle(event.target.value)
              }}
            />
            <Button
              type="submit"
              disabled={pending}
              className={cn('shrink-0', pending && 'motion-safe:animate-pulse')}
            >
              {pending ? t('notes.composer.pending') : t('notes.composer.submit')}
            </Button>
          </div>
        )}
      </Field>
    </form>
  )
}
