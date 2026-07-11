import { MatrixPanel } from '../features/matrix/MatrixPanel'

// Lazy route module: App.tsx pulls this via React.lazy(() =>
// import('./screens/MatrixScreen')), so it MUST be a default export. Keeping the
// data-dense matrix behind a dynamic import splits it out of the initial bundle.
export default function MatrixScreen() {
  return <MatrixPanel />
}
