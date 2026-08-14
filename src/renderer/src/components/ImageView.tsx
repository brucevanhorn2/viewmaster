export default function ImageView({ src }: { src: string }): React.JSX.Element {
  return (
    <div className="image-view">
      <img src={src} alt="" />
    </div>
  )
}
