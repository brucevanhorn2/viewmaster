import { useEffect, useState } from 'react'
import Placeholder from './Placeholder'

export default function ImageView({ src }: { src: string }): React.JSX.Element {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [src])

  if (failed) {
    return <Placeholder title="Image could not be displayed" detail="Not a valid image file" />
  }

  return (
    <div className="image-view">
      <img src={src} alt="" onError={() => setFailed(true)} />
    </div>
  )
}
