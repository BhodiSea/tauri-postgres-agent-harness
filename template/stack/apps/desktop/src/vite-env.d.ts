/// <reference types="vite/client" />

// Opting into strict env typing removes Vite's permissive `[key: string]: any`
// index signature, so only the vars declared below typecheck.
interface ViteTypeOptions {
  strictImportMetaEnv: unknown
}

interface ImportMetaEnv {
  /** Dev-only API origin override; production falls back to the origin baked into the committed CSP. */
  readonly VITE_API_ORIGIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
