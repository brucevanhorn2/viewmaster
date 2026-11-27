import type { SecondLookApi } from './index'

declare global {
  interface Window {
    secondLook: SecondLookApi
  }
}

export {}
