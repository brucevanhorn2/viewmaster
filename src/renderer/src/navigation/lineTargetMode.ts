/**
 * A line-targeted navigation (e.g. a Find-in-Files search match) needs the
 * raw-text 'code' mode to be meaningful -- a rendered view has no
 * line-number mapping to scroll to or highlight. Both markdown and HTML
 * files render into a non-code view by default, so a line target for
 * either one must force 'code' mode for the matched line to actually be
 * shown. Every other file type already opens directly in 'code' mode, so
 * this only needs to act for the file types that have a non-code default.
 */
export function requiresCodeModeForLineTarget(params: {
  isMarkdown: boolean
  isHtml: boolean
  hasLineTarget: boolean
}): boolean {
  return params.hasLineTarget && (params.isMarkdown || params.isHtml)
}
