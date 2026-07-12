import { MatrixPanel } from '../features/matrix/MatrixPanel'
import type { RegisterCommands } from '../features/palette/CommandPalette'

// Lazy route module: App.tsx pulls this via React.lazy(() =>
// import('./screens/MatrixScreen')), so it MUST be a default export. Keeping the
// data-dense matrix behind a dynamic import splits it out of the initial bundle.
// `registerCommands` is the screen half of the contextual-palette contract —
// see RegisterCommands in features/palette/CommandPalette.tsx.
interface MatrixScreenProps {
  readonly registerCommands: RegisterCommands
}

export default function MatrixScreen({ registerCommands }: MatrixScreenProps) {
  return <MatrixPanel registerCommands={registerCommands} />
}
