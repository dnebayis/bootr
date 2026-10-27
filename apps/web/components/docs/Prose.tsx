import type { ReactNode } from 'react';

export function H1({ children }: { children: ReactNode }) {
  return <h1 className="text-display-lg font-semibold text-ink">{children}</h1>;
}
export function Lead({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-base text-body">{children}</p>;
}
export function H2({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h2 id={id} className="mt-10 scroll-mt-20 text-display-sm font-semibold text-ink">
      {children}
    </h2>
  );
}
export function P({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-base leading-7 text-body">{children}</p>;
}
export function UL({ children }: { children: ReactNode }) {
  return <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-base leading-7 text-body marker:text-mute">{children}</ul>;
}
export function OL({ children }: { children: ReactNode }) {
  return <ol className="mt-3 flex list-decimal flex-col gap-1.5 pl-5 text-base leading-7 text-body marker:font-mono marker:text-mute">{children}</ol>;
}
export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-xs border border-hairline bg-canvas-soft px-1 py-px font-mono text-[0.85em] text-ink">{children}</code>;
}
export function Pre({ children, label }: { children: string; label?: string }) {
  return (
    <figure className="mt-4 overflow-hidden rounded-md border border-hairline bg-canvas-soft">
      {label ? <figcaption className="border-b border-hairline px-4 py-2 font-mono text-micro text-mute">{label}</figcaption> : null}
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[13px] leading-5 text-ink">
        <code>{children}</code>
      </pre>
    </figure>
  );
}
export function Note({ children }: { children: ReactNode }) {
  return <div className="mt-4 rounded-sm border border-hairline bg-canvas-soft px-4 py-3 text-sm text-body">{children}</div>;
}
export function Table({ head, rows }: { head: string[]; rows: (string | ReactNode)[][] }) {
  return (
    <div className="mt-4 overflow-x-auto rounded-md border border-hairline">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-canvas-soft text-left text-caption text-mute">
            {head.map((h, i) => (
              <th key={i} scope="col" className={`px-4 py-2 font-normal ${i > 0 ? 'text-right' : ''}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-hairline">
              {r.map((c, j) => (
                <td key={j} className={`px-4 py-2 ${j > 0 ? 'text-right font-mono tabular text-ink' : 'text-body'}`}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
