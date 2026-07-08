import type { ViewmasterApi } from './index'

declare global {
  interface Window {
    viewmaster: ViewmasterApi
  }
}

export {}
