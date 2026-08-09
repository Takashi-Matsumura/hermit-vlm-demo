import { test } from "node:test";
import assert from "node:assert/strict";

import { annotationGeometry, parseStepAnnotation, readPngSize } from "./annotation.ts";
import type { AnnotationTarget } from "./types.ts";

const FRAME = { width: 1280, height: 720 };

test("正常系: 1件の target を受理する", () => {
  const raw = JSON.stringify({
    found: true,
    targets: [{ label: "終了", kind: "button", bbox_2d: [581, 441, 632, 487] }],
  });
  const result = parseStepAnnotation(raw, FRAME);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.annotation.targets.length, 1);
    assert.equal(result.annotation.targets[0].label, "終了");
    assert.equal(result.annotation.frameWidth, 1280);
    assert.equal(result.annotation.frameHeight, 720);
  }
});

test("正常系: 4件はそのまま、5件目以降は切り詰める", () => {
  const targets = Array.from({ length: 5 }, (_, i) => ({
    label: `要素${i}`,
    kind: "button",
    // 重ならないように少しずつ位置をずらす
    bbox_2d: [10 + i * 50, 10, 40 + i * 50, 40],
  }));
  const raw = JSON.stringify({ found: true, targets });
  const result = parseStepAnnotation(raw, FRAME);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.annotation.targets.length, 4);
  }
});

test("```json フェンス付き・前置き文付きでもパースできる", () => {
  const raw =
    "はい、対象を特定しました。\n```json\n" +
    JSON.stringify({ found: true, targets: [{ label: "印刷", kind: "button", bbox_2d: [100, 100, 200, 150] }] }) +
    "\n```";
  const result = parseStepAnnotation(raw, FRAME);
  assert.equal(result.ok, true);
});

test("found: false は not_found", () => {
  const raw = JSON.stringify({ found: false, targets: [] });
  const result = parseStepAnnotation(raw, FRAME);
  assert.deepEqual(result, { ok: false, reason: "not_found" });
});

test('found: "true"（文字列）は not_found として扱う', () => {
  const raw = JSON.stringify({ found: "true", targets: [{ label: "x", kind: "button", bbox_2d: [1, 1, 2, 2] }] });
  const result = parseStepAnnotation(raw, FRAME);
  assert.deepEqual(result, { ok: false, reason: "not_found" });
});

test("found 欠落は not_found", () => {
  const raw = JSON.stringify({ targets: [{ label: "x", kind: "button", bbox_2d: [10, 10, 40, 40] }] });
  const result = parseStepAnnotation(raw, FRAME);
  assert.deepEqual(result, { ok: false, reason: "not_found" });
});

test("JSON が見つからない場合は no_json", () => {
  const result = parseStepAnnotation("すみません、わかりません。", FRAME);
  assert.deepEqual(result, { ok: false, reason: "no_json" });
});

test("範囲外座標（ピクセルモード疑い）は棄却される", () => {
  const raw = JSON.stringify({
    found: true,
    targets: [{ label: "x", kind: "button", bbox_2d: [1200, 300, 1250, 340] }],
  });
  const result = parseStepAnnotation(raw, FRAME);
  assert.deepEqual(result, { ok: false, reason: "no_valid_target" });
});

test("左右・上下が入れ替わっていても並べ替えて採用する", () => {
  // x: 500→417 (逆順)、y: 450→400 (逆順)。並べ替え後は w=83, h=50 で退化しない
  const raw = JSON.stringify({
    found: true,
    targets: [{ label: "x", kind: "button", bbox_2d: [500, 450, 417, 400] }],
  });
  const result = parseStepAnnotation(raw, FRAME);
  assert.equal(result.ok, true);
  if (result.ok) {
    const box = result.annotation.targets[0].box;
    assert.equal(box.x1, 417);
    assert.equal(box.x2, 500);
    assert.equal(box.y1, 400);
    assert.equal(box.y2, 450);
  }
});

test("画面全体を覆う枠は面積比で棄却される", () => {
  const raw = JSON.stringify({
    found: true,
    targets: [{ label: "x", kind: "other", bbox_2d: [0, 0, 1000, 1000] }],
  });
  const result = parseStepAnnotation(raw, FRAME);
  assert.deepEqual(result, { ok: false, reason: "no_valid_target" });
});

test("退化した枠（幅が細すぎる）は棄却される", () => {
  const raw = JSON.stringify({
    found: true,
    targets: [{ label: "x", kind: "other", bbox_2d: [400, 400, 405, 500] }],
  });
  const result = parseStepAnnotation(raw, FRAME);
  assert.deepEqual(result, { ok: false, reason: "no_valid_target" });
});

test("同一枠2件は IoU で1件にまとめられる", () => {
  const raw = JSON.stringify({
    found: true,
    targets: [
      { label: "終了", kind: "button", bbox_2d: [581, 441, 632, 487] },
      { label: "終了（重複）", kind: "button", bbox_2d: [582, 442, 633, 488] },
    ],
  });
  const result = parseStepAnnotation(raw, FRAME);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.annotation.targets.length, 1);
    assert.equal(result.annotation.targets[0].label, "終了");
  }
});

test("targets が空配列なら no_valid_target", () => {
  const raw = JSON.stringify({ found: true, targets: [] });
  const result = parseStepAnnotation(raw, FRAME);
  assert.deepEqual(result, { ok: false, reason: "no_valid_target" });
});

test("readPngSize: 実測サンプル相当の 1280x720 IHDR を読める", () => {
  // PNG シグネチャ(8) + IHDRチャンク長(4) + "IHDR"(4) + width(4) + height(4) ...
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(0x89504e47, 0); // 実際は8バイトのシグネチャだが先頭4バイトだけ検証対象
  buf.writeUInt32BE(1280, 16);
  buf.writeUInt32BE(720, 20);
  const size = readPngSize(buf);
  assert.deepEqual(size, { width: 1280, height: 720 });
});

test("readPngSize: PNG シグネチャでなければ null", () => {
  const buf = Buffer.alloc(24);
  assert.equal(readPngSize(buf), null);
});

test("annotationGeometry: 実測のドロップダウン位置を包含する", () => {
  // 実機検証済みの応答: {"bbox_2d": [417, 398, 506, 427]}
  // 実際のドロップダウン位置は x533-643, y291-309（1280x720）
  const target: AnnotationTarget = {
    label: "ユーザー",
    kind: "dropdown",
    box: { x1: 417, y1: 398, x2: 506, y2: 427 },
  };
  const g = annotationGeometry(target, 1, 1280, 720);

  // 実機検証: x 533.8-647.7, y 286.6-307.4 が実際のドロップダウン位置と一致
  const expectedX1 = (417 / 1000) * 1280;
  const expectedX2 = (506 / 1000) * 1280;
  const expectedY1 = (398 / 1000) * 720;
  const expectedY2 = (427 / 1000) * 720;

  // pad ぶん外側に広がっているはずなので、無pad の枠を完全に包含する
  assert.ok(g.rect.x <= expectedX1);
  assert.ok(g.rect.y <= expectedY1);
  assert.ok(g.rect.x + g.rect.width >= expectedX2);
  assert.ok(g.rect.y + g.rect.height >= expectedY2);

  // 実測のドロップダウン位置（x533-643, y291-309）も包含すること
  assert.ok(g.rect.x <= 533);
  assert.ok(g.rect.x + g.rect.width >= 643);
  assert.ok(g.rect.y <= 291);
  assert.ok(g.rect.y + g.rect.height >= 309);
});

test("annotationGeometry: バッジは画面端でもはみ出さない", () => {
  const target: AnnotationTarget = {
    label: "",
    kind: "button",
    box: { x1: 0, y1: 0, x2: 30, y2: 30 },
  };
  const g = annotationGeometry(target, 1, 1280, 720);
  assert.ok(g.badge.cx - g.badge.r >= 0);
  assert.ok(g.badge.cy - g.badge.r >= 0);
});
