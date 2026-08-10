/**
 * /manual のヘッダーに出すワークフロー表示（メインエージェント3ステップ + サブエージェント2ステップ）の
 * 状態を導出する純粋関数群。サーバ・クライアントどちらからも参照できるよう node:* は import しない
 * （lib/manual.ts と同じ方針）。
 */

export type WorkflowStepId =
  | "transcribe"
  | "caption"
  | "compose"
  | "verify"
  | "annotate"
  // 意図駆動モード（NARRATED_WORKFLOW_STEPS）のみで使う値
  | "intent"
  | "plan"
  | "capture";
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

/**
 * /api/manual/narrated/analyze の SSE で最後に届いたイベント種別。
 * deriveWorkflow / AnalyzePhase とは別に用意する。意図駆動モードは
 * 完成動画モードと emit 順序そのものが異なる（フレーム抽出が意図把握の後段になる）ため、
 * 1本の phase 値で共有すると route.ts の変更が両モードに波及してしまう。
 *
 * chunk・capture・step は mapWithConcurrency による並列実行なので完了順に届く。
 * このため下の deriveNarratedWorkflow は、素材の収集・本文の執筆ステップの完了判定に
 * この phase の前後関係ではなく summary/done への到達（＝全手順ぶんのループが終わったこと）
 * を使う（deriveWorkflow の caption ステップと同じ考え方）。
 */
export type NarratedPhase =
  | ""
  | "info"
  | "utterances"
  | "chunk"
  | "intent"
  | "plan"
  | "capture"
  | "step"
  | "summary"
  | "done";

const NARRATED_PHASE_ORDER: readonly NarratedPhase[] = [
  "",
  "info",
  "utterances",
  "chunk",
  "intent",
  "plan",
  "capture",
  "step",
  "summary",
  "done",
];

/**
 * chunk・capture・step は並列実行で完了順に届くため、クライアント側で phase state を
 * 更新するときは単純な上書き（last-wins）ではなく、この rank を使った最大値更新にすること
 * （例: setPhase(prev => narratedPhaseRank(next) > narratedPhaseRank(prev) ? next : prev)）。
 * でなければ、後から届いた低ランクのイベントでフェーズ表示が逆行してしまう。
 */
export function narratedPhaseRank(phase: NarratedPhase): number {
  return NARRATED_PHASE_ORDER.indexOf(phase);
}

/** 表示順そのもの（メインエージェント→サブエージェント）。WORKFLOW_STEPS とは無関係に独立して持つ */
export const NARRATED_WORKFLOW_STEPS: readonly WorkflowStepMeta[] = [
  { id: "transcribe", label: "文字起こし", model: "whisper.cpp", tier: "main" },
  { id: "intent", label: "意図の把握", model: "gemma-4-12b", tier: "main" },
  { id: "plan", label: "構成の決定", model: "gemma-4-12b", tier: "main" },
  { id: "capture", label: "素材の収集", model: "Qwen3-VL", tier: "main" },
  { id: "compose", label: "本文の執筆", model: "gemma-4-12b", tier: "main" },
  { id: "verify", label: "検証", model: "Qwen3-VL", tier: "sub" },
  { id: "annotate", label: "注釈", model: "Qwen3-VL", tier: "sub" },
];

export type NarratedWorkflowInput = {
  status: "idle" | "analyzing" | "done" | "error";
  phase: NarratedPhase;
  utteranceCount: number;
  /** info イベントで確定する、発話チャンクの総数 */
  chunkCount: number;
  /** chunk イベントで実際に届いた件数 */
  chunkDoneCount: number;
  /** plan イベントで確定する、計画された手順の総数 */
  plannedCount: number;
  /** capture イベントの total（未着なら0） */
  captureTotal: number;
  /** capture イベントで実際に届いた件数 */
  captureDoneCount: number;
  /** step イベントで実際に確定した手順数 */
  stepCount: number;
  verify: SubAgentRun;
  annotate: SubAgentRun;
};

export function deriveNarratedWorkflow(input: NarratedWorkflowInput): WorkflowStepView[] {
  const rank = narratedPhaseRank(input.phase);

  // 文字起こし: 意図駆動モードは全文文字起こしが前提で、音声が無ければ route.ts が
  // error で打ち切る（skipped にはならない）。info 到着後は常に件数付きで done。
  const transcribe: WorkflowStepView = (() => {
    if (rank < narratedPhaseRank("info")) {
      return {
        ...NARRATED_WORKFLOW_STEPS[0],
        status: input.status === "error" ? "failed" : input.status === "analyzing" ? "running" : "pending",
      };
    }
    return { ...NARRATED_WORKFLOW_STEPS[0], status: "done", detail: `${input.utteranceCount}件` };
  })();

  // 意図の把握: map フェーズ（チャンクごとの局所アウトライン）+ reduce フェーズ。
  // intent イベント到着で完了。
  const intent: WorkflowStepView = (() => {
    if (rank < narratedPhaseRank("info")) return { ...NARRATED_WORKFLOW_STEPS[1], status: "pending" };
    if (rank >= narratedPhaseRank("intent")) return { ...NARRATED_WORKFLOW_STEPS[1], status: "done" };
    return {
      ...NARRATED_WORKFLOW_STEPS[1],
      status: input.status === "error" ? "failed" : "running",
      detail: input.chunkCount > 0 ? `${input.chunkDoneCount} / ${input.chunkCount} チャンク` : "起動中…",
    };
  })();

  // 構成の決定: reduce の直後に plan イベントが届く（intent とほぼ同時）
  const plan: WorkflowStepView = (() => {
    if (rank < narratedPhaseRank("intent")) return { ...NARRATED_WORKFLOW_STEPS[2], status: "pending" };
    if (rank >= narratedPhaseRank("plan")) {
      return { ...NARRATED_WORKFLOW_STEPS[2], status: "done", detail: `${input.plannedCount}項目` };
    }
    return { ...NARRATED_WORKFLOW_STEPS[2], status: input.status === "error" ? "failed" : "running" };
  })();

  // 素材の収集: 手順ごとに並列でフレーム抽出が進むため、summary 到達を完了の判定に使う
  const capture: WorkflowStepView = (() => {
    if (rank < narratedPhaseRank("plan")) return { ...NARRATED_WORKFLOW_STEPS[3], status: "pending" };
    if (rank >= narratedPhaseRank("summary")) {
      return {
        ...NARRATED_WORKFLOW_STEPS[3],
        status: "done",
        detail: `${input.captureDoneCount} / ${input.captureTotal} フレーム`,
      };
    }
    return {
      ...NARRATED_WORKFLOW_STEPS[3],
      status: input.status === "error" ? "failed" : "running",
      detail: input.captureTotal > 0 ? `${input.captureDoneCount} / ${input.captureTotal} フレーム` : undefined,
    };
  })();

  // 本文の執筆: 手順ごとの capture の直後に writeNarratedStep が走る。summary〜done の区間は
  // embed + result.json 書き込みが終わるまで「保存中…」として running のまま見せる。
  const compose: WorkflowStepView = (() => {
    if (rank < narratedPhaseRank("plan")) return { ...NARRATED_WORKFLOW_STEPS[4], status: "pending" };
    if (rank >= narratedPhaseRank("done")) {
      return { ...NARRATED_WORKFLOW_STEPS[4], status: "done", detail: `${input.stepCount}手順` };
    }
    if (input.status === "error") return { ...NARRATED_WORKFLOW_STEPS[4], status: "failed" };
    return {
      ...NARRATED_WORKFLOW_STEPS[4],
      status: "running",
      detail: rank >= narratedPhaseRank("summary") ? "保存中…" : `${input.stepCount} / ${input.plannedCount} 手順`,
    };
  })();

  const verify: WorkflowStepView = {
    ...NARRATED_WORKFLOW_STEPS[5],
    label: subAgentLabel(NARRATED_WORKFLOW_STEPS[5].label, input.verify.rounds),
    status: subAgentStatus(input.verify),
    detail: subAgentDetail(input.verify),
  };

  const annotate: WorkflowStepView = {
    ...NARRATED_WORKFLOW_STEPS[6],
    label: subAgentLabel(NARRATED_WORKFLOW_STEPS[6].label, input.annotate.rounds),
    status: subAgentStatus(input.annotate),
    detail: subAgentDetail(input.annotate),
  };

  return [transcribe, intent, plan, capture, compose, verify, annotate];
}
