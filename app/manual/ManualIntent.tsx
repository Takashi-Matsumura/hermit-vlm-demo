import type { ManualIntent } from "@/lib/types";

/**
 * 意図駆動モード（実況収録から）でのみ表示する、マニュアル全体の設計図。
 * intent イベントはフレーム処理の前に届くので、画像が1枚も無い段階で
 * 「システムが何を理解したか」を先に見せられる（ManualSteps より上に置く理由）。
 */
export default function ManualIntentView({ intent }: { intent: ManualIntent }) {
  const hasHeader = intent.audience || intent.goal;

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-6">
      <h2 className="mb-3 text-sm font-medium text-zinc-600">このマニュアルについて</h2>

      {hasHeader && (
        <dl className="mb-4 flex flex-col gap-2 text-sm">
          {intent.audience && (
            <div className="flex gap-2">
              <dt className="shrink-0 text-zinc-500">対象読者</dt>
              <dd className="text-zinc-900">{intent.audience}</dd>
            </div>
          )}
          {intent.goal && (
            <div className="flex gap-2">
              <dt className="shrink-0 text-zinc-500">ゴール</dt>
              <dd className="text-zinc-900">{intent.goal}</dd>
            </div>
          )}
        </dl>
      )}

      {intent.prerequisites.length > 0 && (
        <div className="mb-4">
          <h3 className="mb-1.5 text-xs text-zinc-500">前提条件</h3>
          <ul className="flex flex-col gap-1">
            {intent.prerequisites.map((p, i) => (
              <li key={i} className="flex gap-2 text-sm text-zinc-800">
                <span className="text-zinc-400">・</span>
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}

      {intent.cautions.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <h3 className="mb-1.5 text-xs font-medium text-amber-800">注意事項</h3>
          <ul className="flex flex-col gap-1">
            {intent.cautions.map((c, i) => (
              <li key={i} className="text-sm text-amber-900">
                {c.text}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
