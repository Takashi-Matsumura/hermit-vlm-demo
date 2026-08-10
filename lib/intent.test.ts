import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assignCautionsToSteps,
  chunkUtterances,
  coverageRatio,
  dedupeCautions,
  formatUtteranceLines,
  normalizeOutlineGroups,
  parseOutlineChunk,
  parseOutlineReduce,
  repairOutlineGaps,
  selectPlannedFrameTimes,
  utteranceRangeToTimeSpan,
} from "./intent.ts";
import type { Caution, PlannedStep, Utterance } from "./types.ts";

// ---- chunkUtterances -------------------------------------------------

test("chunkUtterances: 0件は空配列", () => {
  assert.deepEqual(chunkUtterances(0, { maxPerChunk: 90, overlap: 2 }), []);
});

test("chunkUtterances: maxPerChunk 以下なら1チャンク", () => {
  assert.deepEqual(chunkUtterances(85, { maxPerChunk: 90, overlap: 2 }), [{ from: 0, to: 84 }]);
});

test("chunkUtterances: 実測相当（400件・maxPerChunk90・overlap2）で全区間を連続に被覆する", () => {
  const chunks = chunkUtterances(400, { maxPerChunk: 90, overlap: 2 });
  assert.equal(chunks[0].from, 0);
  assert.equal(chunks.at(-1)?.to, 399);
  // 隣接チャンクは overlap 分だけ重なり、隙間ができない
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i].from <= chunks[i - 1].to + 1, `チャンク${i}の直前に隙間がある`);
    assert.ok(chunks[i].to - chunks[i].from + 1 <= 90);
  }
});

test("chunkUtterances: overlap が maxPerChunk 以上でも無限ループしない", () => {
  const chunks = chunkUtterances(50, { maxPerChunk: 10, overlap: 100 });
  assert.ok(chunks.length > 0);
  assert.equal(chunks.at(-1)?.to, 49);
});

// ---- formatUtteranceLines ---------------------------------------------

test("formatUtteranceLines: 添字付き・時刻を含まない", () => {
  const utterances: Utterance[] = [
    { start: 0, end: 5, text: "ファイルメニューを開きます" },
    { start: 5, end: 9, text: "インポートを選びます" },
  ];
  const result = formatUtteranceLines(utterances, { from: 0, to: 1 });
  assert.equal(result, "[0] ファイルメニューを開きます\n[1] インポートを選びます");
  assert.ok(!/\d+\.\d+秒|\d+:\d+/.test(result), "時刻を含んではいけない");
});

test("formatUtteranceLines: range が配列長を超えても安全にクリップされる", () => {
  const utterances: Utterance[] = [{ start: 0, end: 5, text: "a" }];
  assert.equal(formatUtteranceLines(utterances, { from: 0, to: 10 }), "[0] a");
});

// ---- parseOutlineChunk --------------------------------------------------

test("parseOutlineChunk: 正常系", () => {
  const raw = JSON.stringify({
    outline: [{ title: "ファイルを開く", intent: "対象ファイルを選ぶ", from: 10, to: 12 }],
    cautions: [{ text: "保存前に閉じない", from: 13, to: 13 }],
  });
  const result = parseOutlineChunk(raw, { from: 10, to: 20 });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.items, [{ title: "ファイルを開く", intent: "対象ファイルを選ぶ", from: 10, to: 12 }]);
    assert.deepEqual(result.cautions, [{ text: "保存前に閉じない", from: 13, to: 13 }]);
  }
});

test("parseOutlineChunk: ```json フェンス・前置き文でもパースできる", () => {
  const raw = "以下のとおりです。\n```json\n" + JSON.stringify({ outline: [{ title: "t", intent: "i", from: 0, to: 0 }] }) + "\n```";
  const result = parseOutlineChunk(raw, { from: 0, to: 5 });
  assert.equal(result.ok, true);
});

test("parseOutlineChunk: cautions 省略時は空配列", () => {
  const raw = JSON.stringify({ outline: [{ title: "t", intent: "i", from: 0, to: 0 }] });
  const result = parseOutlineChunk(raw, { from: 0, to: 5 });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.cautions, []);
});

test("parseOutlineChunk: range 外の from/to を持つ要素は除去される", () => {
  const raw = JSON.stringify({
    outline: [
      { title: "範囲内", intent: "i", from: 5, to: 8 },
      { title: "範囲外", intent: "i", from: 100, to: 105 },
    ],
  });
  const result = parseOutlineChunk(raw, { from: 0, to: 10 });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].title, "範囲内");
  }
});

test("parseOutlineChunk: from > to の要素は除去される", () => {
  const raw = JSON.stringify({ outline: [{ title: "逆転", intent: "i", from: 8, to: 5 }] });
  assert.deepEqual(parseOutlineChunk(raw, { from: 0, to: 10 }), { ok: false });
});

test("parseOutlineChunk: 非整数の添字を持つ要素は除去される（ピクセル座標混入と同じ考え方）", () => {
  const raw = JSON.stringify({ outline: [{ title: "小数", intent: "i", from: 1.5, to: 2 }] });
  assert.deepEqual(parseOutlineChunk(raw, { from: 0, to: 10 }), { ok: false });
});

test("parseOutlineChunk: 有効な要素が1つも無ければ失敗扱い", () => {
  assert.deepEqual(parseOutlineChunk(JSON.stringify({ outline: [] }), { from: 0, to: 10 }), { ok: false });
});

test("parseOutlineChunk: outline が配列でなければ失敗扱い", () => {
  assert.deepEqual(parseOutlineChunk(JSON.stringify({ outline: "not-an-array" }), { from: 0, to: 10 }), { ok: false });
});

test("parseOutlineChunk: JSONが見つからなければ失敗扱い", () => {
  assert.deepEqual(parseOutlineChunk("わかりません。", { from: 0, to: 10 }), { ok: false });
});

// ---- parseOutlineReduce --------------------------------------------------

test("parseOutlineReduce: 正常系", () => {
  const raw = JSON.stringify({
    title: "CSVインポート手順書",
    audience: "初めて使う担当者",
    goal: "CSVを取り込めるようになる",
    prerequisites: ["対象ファイルを用意しておく"],
    groups: [{ title: "ファイルを開く", intent: "対象を選ぶ", members: [0, 1] }],
  });
  const result = parseOutlineReduce(raw, 5);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.header.title, "CSVインポート手順書");
    assert.deepEqual(result.header.prerequisites, ["対象ファイルを用意しておく"]);
    assert.deepEqual(result.groups, [{ title: "ファイルを開く", intent: "対象を選ぶ", members: [0, 1] }]);
  }
});

test("parseOutlineReduce: ```json フェンス付きでもパースできる", () => {
  const raw = "```json\n" + JSON.stringify({ title: "t", groups: [{ title: "g", intent: "i", members: [0] }] }) + "\n```";
  assert.equal(parseOutlineReduce(raw, 3).ok, true);
});

test("parseOutlineReduce: 範囲外の member は除去される", () => {
  const raw = JSON.stringify({ title: "t", groups: [{ title: "g", intent: "i", members: [0, 99] }] });
  const result = parseOutlineReduce(raw, 3);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.groups[0].members, [0]);
});

test("parseOutlineReduce: 同一グループ内の重複 member は1つにまとめる", () => {
  const raw = JSON.stringify({ title: "t", groups: [{ title: "g", intent: "i", members: [1, 1, 2] }] });
  const result = parseOutlineReduce(raw, 3);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.groups[0].members, [1, 2]);
});

test("parseOutlineReduce: title が空、または有効な members が無いグループは除去される", () => {
  const raw = JSON.stringify({
    title: "t",
    groups: [
      { title: "", intent: "i", members: [0] },
      { title: "有効", intent: "i", members: [99] }, // 範囲外のみ
      { title: "残る", intent: "i", members: [1] },
    ],
  });
  const result = parseOutlineReduce(raw, 3);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].title, "残る");
  }
});

test("parseOutlineReduce: 文書タイトルが無ければ失敗扱い", () => {
  const raw = JSON.stringify({ groups: [{ title: "g", intent: "i", members: [0] }] });
  assert.deepEqual(parseOutlineReduce(raw, 3), { ok: false });
});

test("parseOutlineReduce: groups が配列でなければ失敗扱い", () => {
  assert.deepEqual(parseOutlineReduce(JSON.stringify({ title: "t", groups: "x" }), 3), { ok: false });
});

// ---- normalizeOutlineGroups ---------------------------------------------

function locals(...ranges: Array<[number, number]>): PlannedStep[] {
  return ranges.map(([from, to], i) => ({ title: `局所${i}`, intent: "", from, to }));
}

test("normalizeOutlineGroups: 連続する members は1項目に統合される", () => {
  const l = locals([10, 12], [13, 15], [16, 18]);
  const result = normalizeOutlineGroups([{ title: "まとめ", intent: "i", members: [0, 1, 2] }], l);
  assert.deepEqual(result, [{ title: "まとめ", intent: "i", from: 10, to: 18 }]);
});

test("★ normalizeOutlineGroups: 非連続 members [3,7] は実測どおり2項目に分割される", () => {
  const l = locals([0, 2], [3, 5], [6, 8], [9, 11], [12, 14], [15, 17], [18, 20], [21, 23]);
  const result = normalizeOutlineGroups([{ title: "g", intent: "i", members: [3, 7] }], l);
  assert.deepEqual(result, [
    { title: "g", intent: "i", from: 9, to: 11 },
    { title: "g", intent: "i", from: 21, to: 23 },
  ]);
});

test("★ normalizeOutlineGroups: [6,12,13] は [6] と [12,13] に分割される", () => {
  const l = locals(
    [0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11], // 0-5
    [12, 13], // 6
    [14, 15], [16, 17], [18, 19], [20, 21], [22, 23], // 7-11
    [24, 25], // 12
    [26, 27], // 13
  );
  const result = normalizeOutlineGroups([{ title: "g", intent: "i", members: [6, 12, 13] }], l);
  assert.deepEqual(result, [
    { title: "g", intent: "i", from: 12, to: 13 },
    { title: "g", intent: "i", from: 24, to: 27 },
  ]);
});

test("★ normalizeOutlineGroups: 複数グループが重複範囲を作った場合、包含される方を除去する", () => {
  // 実測: from/to を直接書かせたときに "9-150" と "20-99" が併存した。
  // members 方式でも同じ局所項目が複数グループに属すと同型の重複が起こりうるため、
  // 最終的な出力で包含関係にある項目は取り除く。
  const l = locals([9, 20], [21, 90], [91, 99], [100, 150]);
  const groups = [
    { title: "広い方", intent: "i", members: [0, 1, 2, 3] }, // 9-150
    { title: "狭い方", intent: "i", members: [1, 2] }, // 21-99（広い方に完全包含）
  ];
  const result = normalizeOutlineGroups(groups, l);
  assert.deepEqual(result, [{ title: "広い方", intent: "i", from: 9, to: 150 }]);
});

test("normalizeOutlineGroups: 範囲外の member は無視される", () => {
  const l = locals([0, 2], [3, 5]);
  const result = normalizeOutlineGroups([{ title: "g", intent: "i", members: [0, 99] }], l);
  assert.deepEqual(result, [{ title: "g", intent: "i", from: 0, to: 2 }]);
});

// ---- coverageRatio -------------------------------------------------------

test("coverageRatio: 全区間を被覆すれば1", () => {
  const items: PlannedStep[] = [{ title: "t", intent: "i", from: 0, to: 9 }];
  assert.equal(coverageRatio(items, 10), 1);
});

test("coverageRatio: 空配列は0", () => {
  assert.equal(coverageRatio([], 10), 0);
});

test("coverageRatio: utteranceCount が0以下なら0", () => {
  assert.equal(coverageRatio([{ title: "t", intent: "i", from: 0, to: 0 }], 0), 0);
});

test("★ coverageRatio: 実測相当（400件中0-84のみ被覆）で約0.21になる", () => {
  const items: PlannedStep[] = [{ title: "t", intent: "i", from: 0, to: 84 }];
  const ratio = coverageRatio(items, 400);
  assert.ok(Math.abs(ratio - 0.2125) < 0.001, `期待値付近ではない: ${ratio}`);
});

test("coverageRatio: 重複範囲は二重にカウントしない", () => {
  const items: PlannedStep[] = [
    { title: "a", intent: "i", from: 0, to: 5 },
    { title: "b", intent: "i", from: 3, to: 9 },
  ];
  assert.equal(coverageRatio(items, 10), 1);
});

// ---- repairOutlineGaps -----------------------------------------------

test("repairOutlineGaps: 全区間被覆済みなら何も足さない", () => {
  const items: PlannedStep[] = [{ title: "t", intent: "i", from: 0, to: 9 }];
  assert.deepEqual(repairOutlineGaps(items, 10, 2), items);
});

test("repairOutlineGaps: minGap 以上の欠落区間を補う", () => {
  const items: PlannedStep[] = [
    { title: "先頭", intent: "i", from: 0, to: 4 },
    { title: "末尾", intent: "i", from: 10, to: 14 },
  ];
  const result = repairOutlineGaps(items, 15, 2);
  assert.equal(result.length, 3);
  assert.deepEqual(result[1], { title: "（未分類の発話 5〜9）", intent: "", from: 5, to: 9 });
});

test("repairOutlineGaps: minGap 未満の欠落区間は補わない", () => {
  const items: PlannedStep[] = [
    { title: "先頭", intent: "i", from: 0, to: 4 },
    { title: "末尾", intent: "i", from: 6, to: 9 },
  ];
  // 5だけが欠落（長さ1）。minGap=2 なら補わない
  const result = repairOutlineGaps(items, 10, 2);
  assert.equal(result.length, 2);
});

test("repairOutlineGaps: 先頭が丸ごと欠落していても検出する", () => {
  const items: PlannedStep[] = [{ title: "後半", intent: "i", from: 5, to: 9 }];
  const result = repairOutlineGaps(items, 10, 3);
  assert.deepEqual(result[0], { title: "（未分類の発話 0〜4）", intent: "", from: 0, to: 4 });
});

// ---- utteranceRangeToTimeSpan ------------------------------------------

const UTTERANCES: Utterance[] = [
  { start: 0, end: 5, text: "a" },
  { start: 5, end: 12, text: "b" },
  { start: 12, end: 20, text: "c" },
];

test("utteranceRangeToTimeSpan: 基本の変換", () => {
  assert.deepEqual(utteranceRangeToTimeSpan({ from: 0, to: 1 }, UTTERANCES, 100), { start: 0, end: 12 });
});

test("utteranceRangeToTimeSpan: duration 末尾はクランプされる", () => {
  const result = utteranceRangeToTimeSpan({ from: 0, to: 2 }, UTTERANCES, 20);
  assert.equal(result.end, 19.95);
});

test("utteranceRangeToTimeSpan: range が配列長を超えてもクランプされる", () => {
  const result = utteranceRangeToTimeSpan({ from: 0, to: 99 }, UTTERANCES, 100);
  assert.deepEqual(result, { start: 0, end: 20 });
});

test("utteranceRangeToTimeSpan: 発話が空なら {0,0}", () => {
  assert.deepEqual(utteranceRangeToTimeSpan({ from: 0, to: 0 }, [], 100), { start: 0, end: 0 });
});

// ---- selectPlannedFrameTimes --------------------------------------------

test("selectPlannedFrameTimes: perStep=1 は中点1枚", () => {
  const result = selectPlannedFrameTimes({ start: 10, end: 20 }, { duration: 100, perStep: 1, minGap: 1, existing: [] });
  assert.deepEqual(result, [15]);
});

test("selectPlannedFrameTimes: perStep=2 は開始と終了", () => {
  const result = selectPlannedFrameTimes({ start: 10, end: 20 }, { duration: 100, perStep: 2, minGap: 1, existing: [] });
  assert.deepEqual(result, [10, 20]);
});

test("selectPlannedFrameTimes: perStep=3 は開始・中点・終了", () => {
  const result = selectPlannedFrameTimes({ start: 0, end: 10 }, { duration: 100, perStep: 3, minGap: 1, existing: [] });
  assert.deepEqual(result, [0, 5, 10]);
});

test("selectPlannedFrameTimes: 短い span では minGap 未満の候補が間引かれ1枚に縮退する", () => {
  const result = selectPlannedFrameTimes({ start: 10, end: 10.2 }, { duration: 100, perStep: 3, minGap: 2, existing: [] });
  assert.equal(result.length, 1);
});

test("selectPlannedFrameTimes: 既存フレームと近い候補は除外される", () => {
  const result = selectPlannedFrameTimes({ start: 10, end: 20 }, { duration: 100, perStep: 2, minGap: 1, existing: [10] });
  assert.deepEqual(result, [20]);
});

test("selectPlannedFrameTimes: duration 末尾を超えない", () => {
  const result = selectPlannedFrameTimes({ start: 90, end: 100 }, { duration: 100, perStep: 2, minGap: 1, existing: [] });
  assert.ok(result.every((t) => t <= 99.95));
});

// ---- dedupeCautions -------------------------------------------------------

test("dedupeCautions: 完全一致テキストは最も早い範囲を残して統合される", () => {
  const cautions: Caution[] = [
    { text: "保存前に閉じない", from: 40, to: 40 },
    { text: "保存前に閉じない", from: 10, to: 10 },
  ];
  assert.deepEqual(dedupeCautions(cautions), [{ text: "保存前に閉じない", from: 10, to: 10 }]);
});

test("dedupeCautions: 範囲を union しない（最も早いものをそのまま残す）", () => {
  const cautions: Caution[] = [
    { text: "同じ注意", from: 60, to: 62 },
    { text: "同じ注意", from: 180, to: 182 },
  ];
  const result = dedupeCautions(cautions);
  assert.deepEqual(result, [{ text: "同じ注意", from: 60, to: 62 }]);
});

test("dedupeCautions: 異なるテキストは別々に残る", () => {
  const cautions: Caution[] = [
    { text: "A", from: 1, to: 1 },
    { text: "B", from: 2, to: 2 },
  ];
  assert.deepEqual(dedupeCautions(cautions), cautions);
});

// ---- assignCautionsToSteps ------------------------------------------------

test("assignCautionsToSteps: 根拠発話が範囲内の手順に紐づく", () => {
  const planned: PlannedStep[] = [
    { title: "手順1", intent: "i", from: 0, to: 5 },
    { title: "手順2", intent: "i", from: 6, to: 10 },
  ];
  const cautions: Caution[] = [{ text: "注意", from: 7, to: 7 }];
  const result = assignCautionsToSteps(cautions, planned);
  assert.deepEqual(result.stepCautions, [[], [{ text: "注意", from: 7, to: 7 }]]);
  assert.deepEqual(result.documentCautions, []);
});

test("assignCautionsToSteps: どの手順にも含まれなければ文書レベルへ", () => {
  const planned: PlannedStep[] = [{ title: "手順1", intent: "i", from: 0, to: 5 }];
  const cautions: Caution[] = [{ text: "注意", from: 20, to: 20 }];
  const result = assignCautionsToSteps(cautions, planned);
  assert.deepEqual(result.stepCautions, [[]]);
  assert.deepEqual(result.documentCautions, cautions);
});

test("assignCautionsToSteps: 境界（from と一致）でも紐づく", () => {
  const planned: PlannedStep[] = [{ title: "手順1", intent: "i", from: 5, to: 10 }];
  const cautions: Caution[] = [
    { text: "開始", from: 5, to: 5 },
    { text: "終了", from: 10, to: 10 },
  ];
  const result = assignCautionsToSteps(cautions, planned);
  assert.equal(result.stepCautions[0].length, 2);
});
