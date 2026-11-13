export default function RemoteImagesBar({
  count,
  onLoad
}: {
  count: number
  onLoad: () => void
}): React.JSX.Element | null {
  if (count === 0) return null
  return (
    <div className="remote-images-bar">
      <span>This document has {count} remote {count === 1 ? 'image' : 'images'}</span>
      <button type="button" onClick={onLoad}>
        Load images
      </button>
    </div>
  )
}
