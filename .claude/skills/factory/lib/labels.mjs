export const FACTORY_LABELS = [
  'factory:queued',
  'factory:brainstorming',
  'factory:plan-ready',
  'factory:executing',
  'factory:awaiting-push',
  'factory:in-review',
  'factory:ready-to-merge',
  'factory:needs-attention'
]

export function isFactoryLabel(name) {
  return FACTORY_LABELS.includes(name)
}

export function computeLabelTransition(currentLabels, newLabel) {
  if (!isFactoryLabel(newLabel)) {
    throw new Error(`Not a factory label: ${newLabel}`)
  }
  const toRemove = currentLabels.filter((l) => isFactoryLabel(l) && l !== newLabel)
  const toAdd = currentLabels.includes(newLabel) ? [] : [newLabel]
  return { toRemove, toAdd }
}
