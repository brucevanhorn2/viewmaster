/// <reference types="vite/client" />

// node-htmldiff ships no type declarations.
declare module 'node-htmldiff' {
  export default function htmldiff(
    before: string,
    after: string,
    className?: string | null,
    dataPrefix?: string | null,
    atomicTags?: string | null
  ): string
}
