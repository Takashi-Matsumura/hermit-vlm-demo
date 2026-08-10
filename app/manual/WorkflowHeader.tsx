import type { WorkflowStepView } from "@/lib/workflow";

const TEXT_CLASS: Record<WorkflowStepView["status"], string> = {
  pending: "text-zinc-600",
  running: "text-emerald-300",
  done: "text-zinc-300",
  skipped: "text-zinc-600",
  failed: "text-red-300",
};

const STATUS_LABEL: Record<WorkflowStepView["status"], string> = {
  pending: "未実行",
  running: "実行中",
  done: "完了",
  skipped: "スキップ",
  failed: "失敗",
};

function StatusIcon({ status }: { status: WorkflowStepView["status"] }) {
  if (status === "done") {
    return (
      <svg
        className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        aria-hidden="true"
      >
        <path d="m5 13 4 4L19 7" />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg
        className="mt-0.5 h-3 w-3 shrink-0 text-red-400"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        aria-hidden="true"
      >
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    );
  }
  if (status === "running") {
    return (
      <span
        className="mt-1 h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-400 ring-2 ring-emerald-500/30"
        aria-hidden="true"
      />
    );
  }
  if (status === "skipped") {
    return <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-zinc-700" aria-hidden="true" />;
  }
  return <span className="mt-1 h-2 w-2 shrink-0 rounded-full border border-zinc-600" aria-hidden="true" />;
}

function Row({ title, steps }: { title: string; steps: WorkflowStepView[] }) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-4">
      <span className="shrink-0 text-[10px] tracking-wide text-zinc-500 sm:w-28 sm:pt-1">{title}</span>
      <ol className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-3">
        {steps.map((step, i) => (
          <li
            key={step.id}
            className="flex items-start gap-3"
            aria-label={`${step.label}: ${STATUS_LABEL[step.status]}${step.detail ? ` ${step.detail}` : ""}`}
          >
            {/* 折り返した行の先頭に線が残らないよう、狭い画面では接続線を出さない */}
            {i > 0 && <span aria-hidden="true" className="mt-2 hidden h-px w-5 shrink-0 bg-zinc-700 sm:block" />}
            <span className="flex items-start gap-1.5">
              <StatusIcon status={step.status} />
              <span className="flex min-w-0 flex-col leading-tight">
                <span className={`text-xs ${TEXT_CLASS[step.status]}`}>
                  {step.label}
                  {step.detail && <span className="ml-1.5 font-mono text-[10px] text-zinc-500">{step.detail}</span>}
                </span>
                <span className="mt-0.5 text-[10px] text-zinc-600">{step.model}</span>
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * /manual のヘッダーに常設するワークフロー表示。メインエージェント（文字起こし・画面解析・
 * 手順生成）とサブエージェント（検証・注釈）を2段で並べ、いま何が動いているかを可視化する。
 * 完了後もステップを消さず、全件「完了」のまま残す。
 */
export default function WorkflowHeader({
  steps,
  progress,
}: {
  steps: WorkflowStepView[];
  /** 画面解析ステップが running のときだけ渡す。null なら進捗バーを出さない */
  progress: { done: number; total: number } | null;
}) {
  const mainSteps = steps.filter((s) => s.tier === "main");
  const subSteps = steps.filter((s) => s.tier === "sub");

  return (
    <div className="mt-4 border-t border-zinc-800 pt-4">
      <h3 className="mb-3 text-[10px] tracking-wide text-zinc-500">ワークフロー</h3>
      <div className="flex flex-col gap-3">
        <Row title="メインエージェント" steps={mainSteps} />
        <div className="h-px bg-zinc-800/80" />
        <Row title="サブエージェント" steps={subSteps} />
      </div>
      {progress && progress.total > 0 && (
        <div className="mt-3 h-1 w-full overflow-hidden rounded bg-zinc-800">
          <div
            className="h-full bg-emerald-500 transition-all duration-300"
            style={{ width: `${(progress.done / progress.total) * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}
