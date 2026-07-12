// Ambient module typing for the ONE Node builtin the e2e lane touches.
// The e2e project deliberately compiles with types:[] and no @types/node
// (Playwright transpiles specs itself; node globals would pollute the
// page.evaluate DOM scope), so interaction-latency.spec.ts's budget read gets
// its minimal surface declared here instead. Ambient module declarations only
// bind from a global (import-free) .d.ts — an in-module `declare module` is an
// augmentation and cannot introduce an unresolvable module's types.
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string
}
