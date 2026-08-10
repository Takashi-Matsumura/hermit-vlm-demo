/**
 * /manual のヘッダーに出すワークフロー表示（メインエージェント3ステップ + サブエージェント2ステップ）の
 * 状態を導出する純粋関数群。サーバ・クライアントどちらからも参照できるよう node:* は import しない
 * （lib/manual.ts と同じ方針）。
 */

export type WorkflowStepId = "transcribe" | "caption" | "compose" | "verify" | "annotate";
export type WorkflowTier = "main" | "sub";
export type WorkflowStepStatus = "pending" | "running" | "done" | "skipped" | "failed";

/**
 * /api/manual/analyze の SSE で最後に届いたイベント種別。"" はまだ何も届いていない状態。
 * error はここに含めない（失敗直前にどこまで進んでいたかをそのまま保持するため）。
 *
 * route.ts の emit 順序は info → utterances?(発話が無ければ来ない) → caption×N → summary → steps → done
 * で単調なので、この1値だけでメインエージェントの全フェーズが決定的に導出できる。
 * 「frames.length が frameCount に届いたか」という枚数比較は使わない
 * （フレーム抽出失敗を握りつぶすフレームがあると、枚数は永久に frameCount に届かないことがある）。
 */
export type AnalyzePhase = "" | "info" | "utterances" | "caption" | "summary" | "steps" | "done";

const PHASE_ORDER: readonly AnalyzePhase[] = ["", "info", "utterances", "caption", "summary", "steps", "done"];

function phaseRank(phase: AnalyzePhase): number {
  return PHASE_ORDER.indexOf(phase);
}

/** verify / annotate サブエージェント1つぶんの実行状態 */
export type SubAgentRun = {
  state: "idle" | "running" | "done" | "failed";
  round: number;
  done: number;
  total: number;
  /** annotate の start イベントで判明する最大周回数。verify は不明なままなので undefined */
  rounds?: number;
  /** done イベントで確定したサマリ（例: "差し替え 3件"） */
  result?: string;
};

export const IDLE_RUN: SubAgentRun = { state: "idle", round: 0, done: 0, total: 0 };

type WorkflowStepMeta = {
  id: WorkflowStepId;
  label: string;
  model: string;
  tier: WorkflowTier;
};

/** 表示順そのもの（メインエージェント→サブエージェント） */
export const WORKFLOW_STEPS: readonly WorkflowStepMeta[] = [
  { id: "transcribe", label: "文字起こし", model: "whisper.cpp", tier: "main" },
  { id: "caption", label: "画面解析", model: "Qwen3-VL", tier: "main" },
  { id: "compose", label: "手順生成", model: "gemma-4-12b", tier: "main" },
  { id: "verify", label: "検証", model: "Qwen3-VL", tier: "sub" },
  { id: "annotate", label: "注釈", model: "Qwen3-VL", tier: "sub" },
];

export type WorkflowStepView = WorkflowStepMeta & {
  status: WorkflowStepStatus;
  detail?: string;
};

export type WorkflowInput = {
  status: "idle" | "analyzing" | "done" | "error";
  phase: AnalyzePhase;
  /** info イベントで確定する、抽出予定のフレーム総数 */
  frameCount: number;
  /** caption イベントで実際に届いた枚数（frameCount に届かないことがある） */
  captionedCount: number;
  utteranceCount: number;
  stepCount: number;
  verify: SubAgentRun;
  annotate: SubAgentRun;
};

/** running 中の「N周目 x / y」表示。周回・total が未確定なら「起動中…」にする（"0周目 0/0" を出さない） */
function subAgentDetail(run: SubAgentRun): string | undefined {
  if (run.state === "idle") return undefined;
  if (run.state === "running") {
    if (run.round === 0 || run.total === 0) return "起動中…";
    return `${run.round}周目 ${run.done} / ${run.total}`;
  }
  if (run.state === "done") return run.result;
  return undefined;
}

function subAgentStatus(run: SubAgentRun): WorkflowStepStatus {
  switch (run.state) {
    case "idle":
      return "pending";
    case "running":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "failed";
  }
}

function subAgentLabel(base: string, rounds: number | undefined): string {
  return `${base}（最大${rounds ?? 3}周）`;
}

export function deriveWorkflow(input: WorkflowInput): WorkflowStepView[] {
  const rank = phaseRank(input.phase);

  // 文字起こし: info 未着なら analyzing/error で running/failed。info 到着後は
  // utteranceCount で「音声があったか」を判定する（utterances イベント自体は
  // 発話が無いと送られないので使わない）。
  const transcribe: WorkflowStepView = (() => {
    if (rank < phaseRank("info")) {
      return {
        ...WORKFLOW_STEPS[0],
        status: input.status === "error" ? "failed" : input.status === "analyzing" ? "running" : "pending",
      };
    }
    if (input.utteranceCount > 0) {
      return { ...WORKFLOW_STEPS[0], status: "done", detail: `${input.utteranceCount}件` };
    }
    return { ...WORKFLOW_STEPS[0], status: "skipped", detail: "音声なし" };
  })();

  // 画面解析: summary 以降に到達していれば、抽出失敗フレームがあっても完了とみなす。
  // 枚数表示（detail）だけは captionedCount/frameCount の比較を残し、
  // スキップされた枚数が見えるようにする。
  const caption: WorkflowStepView = (() => {
    if (rank < phaseRank("info")) return { ...WORKFLOW_STEPS[1], status: "pending" };
    if (input.frameCount === 0) return { ...WORKFLOW_STEPS[1], status: "skipped", detail: "フレームなし" };
    if (rank >= phaseRank("summary")) {
      return { ...WORKFLOW_STEPS[1], status: "done", detail: `${input.captionedCount} / ${input.frameCount} フレーム` };
    }
    return {
      ...WORKFLOW_STEPS[1],
      status: input.status === "error" ? "failed" : "running",
      detail: `${input.captionedCount} / ${input.frameCount} フレーム`,
    };
  })();

  // 手順生成: summary〜done の区間。steps イベント後、embed + result.json 書き込みが
  // 終わるまでは「保存中…」として running のまま見せる。
  const compose: WorkflowStepView = (() => {
    if (rank < phaseRank("summary")) return { ...WORKFLOW_STEPS[2], status: "pending" };
    if (rank >= phaseRank("done")) {
      return { ...WORKFLOW_STEPS[2], status: "done", detail: `${input.stepCount}手順` };
    }
    if (input.status === "error") return { ...WORKFLOW_STEPS[2], status: "failed" };
    return { ...WORKFLOW_STEPS[2], status: "running", detail: rank >= phaseRank("steps") ? "保存中…" : undefined };
  })();

  const verify: WorkflowStepView = {
    ...WORKFLOW_STEPS[3],
    label: subAgentLabel(WORKFLOW_STEPS[3].label, input.verify.rounds),
    status: subAgentStatus(input.verify),
    detail: subAgentDetail(input.verify),
  };

  const annotate: WorkflowStepView = {
    ...WORKFLOW_STEPS[4],
    label: subAgentLabel(WORKFLOW_STEPS[4].label, input.annotate.rounds),
    status: subAgentStatus(input.annotate),
    detail: subAgentDetail(input.annotate),
  };

  return [transcribe, caption, compose, verify, annotate];
}
