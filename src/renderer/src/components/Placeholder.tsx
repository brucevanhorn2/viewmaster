export default function Placeholder({
  title,
  detail
}: {
  title: string
  detail?: string
}): React.JSX.Element {
  return (
    <div className="placeholder">
      <div className="placeholder-title">{title}</div>
      {detail && <div className="placeholder-detail">{detail}</div>}
    </div>
  )
}
