import { test } from "node:test";
import assert from "node:assert/strict";

import { dedupeRepeatedUtterances } from "./audio.ts";
import type { Utterance } from "./audio.ts";

test("重複が無ければそのまま返す", () => {
  const utterances: Utterance[] = [
    { start: 0, end: 7, text: "送り状の入力方法" },
    { start: 7, end: 15, text: "次に、upackprintrで送り状を入力する方法を説明します。" },
  ];
  assert.deepEqual(dedupeRepeatedUtterances(utterances), utterances);
});

test("20秒未満の間隔で連続する同一テキストは先頭だけ残す（実データ相当・21回の連続反復）", () => {
  // 実測: 217〜286秒に「郵便番号から、ご依頼主を入力しました。」が21回、
  // 最大ギャップは262→278の16秒
  const times = [217, 220, 222, 224, 227, 229, 232, 234, 236, 238, 240, 242, 244, 246, 248, 260, 262, 278, 280, 282, 284, 286];
  const text = "郵便番号から、ご依頼主を入力しました。";
  const utterances: Utterance[] = times.map((t) => ({ start: t, end: t + 2, text }));

  const result = dedupeRepeatedUtterances(utterances);
  assert.equal(result.length, 1);
  assert.equal(result[0].start, 217);
});

test("別テキストが交互に挟まっていても、テキストごとに間引く（実データ相当）", () => {
  // 実測: 419〜460秒に「印刷済みの送り状が確認できます。」と「閉じるをクリックします。」が
  // 数秒間隔で交互に出現する
  const utterances: Utterance[] = [
    { start: 419, end: 433, text: "印刷済みの送り状が確認できます。" },
    { start: 433, end: 436, text: "印刷済みの送り状が確認できます。" },
    { start: 436, end: 440, text: "閉じるをクリックします。" },
    { start: 440, end: 442, text: "印刷済みの送り状が確認できます。" },
    { start: 442, end: 445, text: "印刷済みの送り状が確認できます。" },
    { start: 445, end: 446, text: "閉じるをクリックします。" },
    { start: 446, end: 447, text: "印刷済みの送り状が確認できます。" },
    { start: 447, end: 448, text: "閉じるをクリックします。" },
    { start: 448, end: 450, text: "印刷済みの送り状が確認できます。" },
  ];

  const result = dedupeRepeatedUtterances(utterances);
  assert.equal(result.length, 2);
  assert.equal(result[0].text, "印刷済みの送り状が確認できます。");
  assert.equal(result[0].start, 419);
  assert.equal(result[1].text, "閉じるをクリックします。");
  assert.equal(result[1].start, 436);
});

test("20秒以上離れていれば、同一テキストでも別の発話として残す", () => {
  const utterances: Utterance[] = [
    { start: 0, end: 4, text: "お届け先を入力しました。" },
    { start: 100, end: 104, text: "お届け先を入力しました。" },
  ];
  assert.deepEqual(dedupeRepeatedUtterances(utterances), utterances);
});

test("空配列はそのまま返す", () => {
  assert.deepEqual(dedupeRepeatedUtterances([]), []);
});
