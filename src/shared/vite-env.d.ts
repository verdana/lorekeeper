// Global type declarations shared by the web and node tsconfigs.
//
// `import.meta.env.VITE_PROMPT_LANG` must be accessed verbatim so Vite can
// statically inline it at build time (src/shared/prompts/index.ts). The web
// config already gets ImportMetaEnv from vite/client; the node config does
// not, so declare the minimal shape here for both.
interface ImportMetaEnv {
  readonly VITE_PROMPT_LANG?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
