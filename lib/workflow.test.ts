import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveWorkflow, IDLE_RUN, WORKFLOW_STEPS, type SubAgentRun, type WorkflowInput } from "./workflow.ts";

/** 5ステップ分そろえた入力を作る。個別のテストでは差分だけ上書きする */
function baseInput(overrides: Partial<WorkflowInput> = {}): WorkflowInput {
  return {
    status: "idle",
    phase: "",
    frameCount: 0,
    captionedCount: 0,
    utteranceCount: 0,
    stepCount: 0,
    verify: IDLE_RUN,
    annotate: IDLE_RUN,
    ...overrides,
  };
}

function statuses(input: WorkflowInput) {
  return deriveWorkflow(input).map((s) => s.status);
}

test("idle: 全5件 pending", () => {
  assert.deepEqual(statuses(baseInput()), ["pending", "pending", "pending", "pending", "pending"]);
});

test("analyzing かつ info未着: 文字起こしのみ running、他は pending", () => {
  const result = deriveWorkflow(baseInput({ status: "analyzing", phase: "" }));
  assert.deepEqual(
    result.map((s) => s.status),
    ["running", "pending", "pending", "pending", "pending"],
  );
});

test("info到着・音声なし: 文字起こしは skipped「音声なし」、画面解析は running", () => {
  const result = deriveWorkflow(
    baseInput({ status: "analyzing", phase: "info", frameCount: 24, utteranceCount: 0 }),
  );
  assert.equal(result[0].status, "skipped");
  assert.equal(result[0].detail, "音声なし");
  assert.equal(result[1].status, "running");
});

test("info到着・音声あり: 文字起こしは done「51件」", () => {
  const result = deriveWorkflow(
    baseInput({ status: "analyzing", phase: "info", frameCount: 24, utteranceCount: 51 }),
  );
  assert.equal(result[0].status, "done");
  assert.equal(result[0].detail, "51件");
});

test("caption途中: 画面解析は running「7 / 24 フレーム」", () => {
  const result = deriveWorkflow(
    baseInput({ status: "analyzing", phase: "caption", frameCount: 24, captionedCount: 7, utteranceCount: 51 }),
  );
  assert.equal(result[1].status, "running");
  assert.equal(result[1].detail, "7 / 24 フレーム");
});

test("★ summary到着時点で captionedCount が frameCount に届いていなくても画面解析は done", () => {
  // route.ts はフレーム抽出失敗を握りつぶして caption イベントを送らないことがあるため、
  // 枚数比較では「画面解析」が永久に完了しない。summary イベントの到着そのものを完了の証拠にする。
  const result = deriveWorkflow(
    baseInput({ status: "analyzing", phase: "summary", frameCount: 24, captionedCount: 22, utteranceCount: 51 }),
  );
  assert.equal(result[1].status, "done");
  assert.equal(result[1].detail, "22 / 24 フレーム");
});

test("frameCount が 0: 画面解析は skipped「フレームなし」", () => {
  const result = deriveWorkflow(baseInput({ status: "analyzing", phase: "info", frameCount: 0 }));
  assert.equal(result[1].status, "skipped");
  assert.equal(result[1].detail, "フレームなし");
});

test("summary到着: 手順生成は running", () => {
  const result = deriveWorkflow(baseInput({ status: "analyzing", phase: "summary", frameCount: 24 }));
  assert.equal(result[2].status, "running");
});

test("steps到着: 手順生成は running「保存中…」", () => {
  const result = deriveWorkflow(baseInput({ status: "analyzing", phase: "steps", frameCount: 24, stepCount: 17 }));
  assert.equal(result[2].status, "running");
  assert.equal(result[2].detail, "保存中…");
});

test("done到着: 手順生成は done「17手順」、サブエージェント2件は pending", () => {
  const result = deriveWorkflow(
    baseInput({ status: "done", phase: "done", frameCount: 24, stepCount: 17, utteranceCount: 51 }),
  );
  assert.equal(result[2].status, "done");
  assert.equal(result[2].detail, "17手順");
  assert.equal(result[3].status, "pending");
  assert.equal(result[4].status, "pending");
});

test("★ verify running かつ round:0,total:0 は「起動中…」（0周目0/0を出さない）", () => {
  const run: SubAgentRun = { state: "running", round: 0, done: 0, total: 0 };
  const result = deriveWorkflow(baseInput({ status: "done", phase: "done", verify: run }));
  assert.equal(result[3].status, "running");
  assert.equal(result[3].detail, "起動中…");
});

test("verify running・周回確定後: 「2周目 3 / 17」", () => {
  const run: SubAgentRun = { state: "running", round: 2, done: 3, total: 17 };
  const result = deriveWorkflow(baseInput({ status: "done", phase: "done", verify: run }));
  assert.equal(result[3].detail, "2周目 3 / 17");
});

test("verify done: サマリ文言がそのまま detail に出る", () => {
  const run: SubAgentRun = { state: "done", round: 3, done: 17, total: 17, result: "差し替え 3件" };
  const result = deriveWorkflow(baseInput({ status: "done", phase: "done", verify: run }));
  assert.equal(result[3].status, "done");
  assert.equal(result[3].detail, "差し替え 3件");
});

test("verify failed: annotate は pending のまま", () => {
  const run: SubAgentRun = { state: "failed", round: 1, done: 0, total: 17 };
  const result = deriveWorkflow(baseInput({ status: "done", phase: "done", verify: run }));
  assert.equal(result[3].status, "failed");
  assert.equal(result[4].status, "pending");
});

test("status:error かつ phase:''（info未着）: 文字起こしのみ failed、他は pending", () => {
  const result = deriveWorkflow(baseInput({ status: "error", phase: "" }));
  assert.deepEqual(
    result.map((s) => s.status),
    ["failed", "pending", "pending", "pending", "pending"],
  );
});

test("status:error かつ phase:caption（音声ありの後）: 文字起こしは done、画面解析は failed、手順生成は pending", () => {
  const result = deriveWorkflow(
    baseInput({ status: "error", phase: "caption", frameCount: 24, captionedCount: 5, utteranceCount: 51 }),
  );
  assert.equal(result[0].status, "done");
  assert.equal(result[1].status, "failed");
  assert.equal(result[2].status, "pending");
});

test("status:error かつ phase:summary: 手順生成が failed", () => {
  const result = deriveWorkflow(
    baseInput({ status: "error", phase: "summary", frameCount: 24, utteranceCount: 51 }),
  );
  assert.equal(result[1].status, "done");
  assert.equal(result[2].status, "failed");
});

test("返り値の順序と tier: メイン3件→サブ2件", () => {
  const result = deriveWorkflow(baseInput());
  assert.deepEqual(
    result.map((s) => s.id),
    ["transcribe", "caption", "compose", "verify", "annotate"],
  );
  assert.deepEqual(
    result.map((s) => s.tier),
    ["main", "main", "main", "sub", "sub"],
  );
});

test("annotate.rounds:2 のときラベルが「注釈（最大2周）」、未指定なら既定3", () => {
  const withRounds = deriveWorkflow(
    baseInput({ annotate: { state: "running", round: 1, done: 0, total: 5, rounds: 2 } }),
  );
  assert.equal(withRounds[4].label, "注釈（最大2周）");

  const withoutRounds = deriveWorkflow(baseInput({ annotate: IDLE_RUN }));
  assert.equal(withoutRounds[4].label, "注釈（最大3周）");
});

test("WORKFLOW_STEPS は5件、id が一意", () => {
  assert.equal(WORKFLOW_STEPS.length, 5);
  assert.equal(new Set(WORKFLOW_STEPS.map((s) => s.id)).size, 5);
});
