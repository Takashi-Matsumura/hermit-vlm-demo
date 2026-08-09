import { test } from "node:test";
import assert from "node:assert/strict";

import { parseVerification, selectCandidateTimes } from "./verification.ts";
import type { UtteranceRange } from "./verification.ts";

test("selectCandidateTimes: 実データ相当（460秒動画・step2 t=48.882）で妥当な候補が出る", () => {
  // 実データ（public/uploads/56abbc4d-.../result.json）の一部を抜粋
  const utterances: UtteranceRange[] = [
    { start: 30.0, end: 43.0 }, // 発送管理をクリックします。
    { start: 43.0, end: 50.0 }, // upackprintrをクリックします。
    { start: 50.0, end: 56.0 }, // 発送予定日時を入力します。
    { start: 60.0, end: 75.0 }, // 元払い、着払い、代引きが正しく選択できていることを確認します。
  ];
  const existingFrameTimes = [0, 15, 30, 48.882, 82, 97];
  const result = selectCandidateTimes(48.882, utterances, existingFrameTimes, 460.026226);

  // 最近傍は [43.0-50.0]。前後の [30.0-43.0] [50.0-56.0] を含めた start/end が候補になる
  assert.deepEqual(result, [43, 50, 56, 60]);
});

test("selectCandidateTimes: 既存フレームと近い候補は除外される", () => {
  const utterances: UtteranceRange[] = [
    { start: 10, end: 15.4 }, // end が既存フレーム 15.0 に極めて近い
    { start: 20, end: 25 },
  ];
  const existingFrameTimes = [0, 15];
  const result = selectCandidateTimes(12, utterances, existingFrameTimes, 100);
  assert.ok(!result.includes(15.4));
});

test("selectCandidateTimes: duration 末尾ぎりぎりの候補は除外される", () => {
  const utterances: UtteranceRange[] = [{ start: 95, end: 99.99 }];
  const result = selectCandidateTimes(95, utterances, [], 100);
  assert.ok(!result.includes(99.99));
});

test("selectCandidateTimes: 発話が空なら空配列", () => {
  assert.deepEqual(selectCandidateTimes(10, [], [], 100), []);
});

test("selectCandidateTimes: 最大4件に絞られる", () => {
  const utterances: UtteranceRange[] = [
    { start: 0, end: 10 },
    { start: 20, end: 30 },
    { start: 40, end: 50 },
  ];
  const result = selectCandidateTimes(25, utterances, [], 1000);
  assert.ok(result.length <= 4);
});

test("selectCandidateTimes: 先頭・末尾の発話でも範囲外アクセスしない", () => {
  const utterances: UtteranceRange[] = [{ start: 0, end: 5 }];
  const result = selectCandidateTimes(0, utterances, [], 100);
  assert.deepEqual(result, [0, 5]);
});

test("parseVerification: 正常系（現在のまま best=1）", () => {
  const result = parseVerification('{"best": 1}', 3);
  assert.deepEqual(result, { ok: true, best: 1 });
});

test("parseVerification: 正常系（候補を指す best=3）", () => {
  const result = parseVerification('{"best": 3}', 3);
  assert.deepEqual(result, { ok: true, best: 3 });
});

test("parseVerification: 一致なし best=0", () => {
  const result = parseVerification('{"best": 0}', 3);
  assert.deepEqual(result, { ok: true, best: 0 });
});

test("parseVerification: ```json フェンス付き・前置き文付きでもパースできる", () => {
  const raw = "はい、判定しました。\n```json\n" + '{"best": 2}' + "\n```";
  assert.deepEqual(parseVerification(raw, 3), { ok: true, best: 2 });
});

test("parseVerification: 範囲外の best は失敗扱い", () => {
  assert.deepEqual(parseVerification('{"best": 9}', 3), { ok: false });
  assert.deepEqual(parseVerification('{"best": -1}', 3), { ok: false });
});

test("parseVerification: best が数値でなければ失敗扱い", () => {
  assert.deepEqual(parseVerification('{"best": "1"}', 3), { ok: false });
  assert.deepEqual(parseVerification('{"best": 1.5}', 3), { ok: false });
});

test("parseVerification: JSONが見つからなければ失敗扱い", () => {
  assert.deepEqual(parseVerification("わかりません。", 3), { ok: false });
});
