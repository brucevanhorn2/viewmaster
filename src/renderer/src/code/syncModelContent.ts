/** The slice of a Monaco text model that syncModelContent needs. */
export interface SettableModel {
  getValue(): string
  setValue(value: string): void
}

/**
 * Makes a reused model's text equal `content`. A model can be created with a
 * previous file's text during a file switch (a transient render pairs the new
 * path with the old content) and is then reused as-is because the editor
 * ignores `value` for an existing model. Returns true when it had to rewrite.
 */
export function syncModelContent(model: SettableModel | null, content: string): boolean {
  if (!model || model.getValue() === content) return false
  model.setValue(content)
  return true
}
