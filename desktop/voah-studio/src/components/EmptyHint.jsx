export function EmptyHint({ icon = "fa-inbox", title, sub }) {
  return (
    <div className="flex-1 grid place-items-center text-center p-10">
      <div>
        <i className={`fa ${icon} text-4xl text-ink-300 mb-4`} />
        <div className="font-medium text-ink-700">{title}</div>
        {sub && <div className="text-xs text-ink-400 mt-1 max-w-sm">{sub}</div>}
      </div>
    </div>
  );
}

