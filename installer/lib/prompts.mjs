// Interactive prompting for placeholder answers; --yes takes defaults,
// --set VAR=value overrides. Zero-dep: node:readline/promises.
import readline from 'node:readline/promises'
import { PLACEHOLDERS } from './placeholders.mjs'

export async function collectAnswers({ yes, sets, ctx }) {
  const answers = {}
  ctx.answers = answers
  for (const [name, value] of Object.entries(sets)) answers[name] = value

  let rl = null
  for (const [name, spec] of Object.entries(PLACEHOLDERS)) {
    if (name in answers) continue
    const def = spec.default(ctx)
    if (yes) {
      answers[name] = def
      continue
    }
    rl ??= readline.createInterface({ input: process.stdin, output: process.stdout })
    const reply = await rl.question(`${spec.prompt} [${def}]: `)
    answers[name] = reply.trim() === '' ? def : reply.trim()
  }
  rl?.close()
  return answers
}

export function parseSets(setArgs) {
  const sets = {}
  for (const s of setArgs ?? []) {
    const eq = s.indexOf('=')
    if (eq === -1) throw new Error(`--set expects VAR=value, got: ${s}`)
    sets[s.slice(0, eq)] = s.slice(eq + 1)
  }
  return sets
}
