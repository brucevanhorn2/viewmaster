/// <reference types="vite/client" />

// electron-vite rewrites `?asset` imports to a runtime file path (source path
// in dev, copied-into-out path in a build).
declare module '*?asset' {
  const src: string
  export default src
}
