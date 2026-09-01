/**
 * True when a request that captured `myId` has been superseded by a later
 * request (which bumped `currentId` past it) by the time its response
 * arrives. Mirrors `isStaleGeneration` in `src/main/ipc.ts`, which guards
 * the analogous race on the main-process side (which session/watcher wins);
 * this guards the renderer side (which response gets applied to state) --
 * the two are independent races over the same underlying "repo:open calls
 * can resolve out of order" problem, so a response that won the main-process
 * race can still lose this one, and vice versa.
 */
export function isStaleRequest(myId: number, currentId: number): boolean {
  return myId !== currentId
}
