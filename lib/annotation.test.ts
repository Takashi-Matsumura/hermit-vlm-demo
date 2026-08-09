import { test } from "node:test";
import assert from "node:assert/strict";

import {
  annotationGeometry,
  contentViewportFromCropDetect,
  FULL_VIEWPORT,
  hasConverged,
  isFullViewport,
  isPlausibleRefinement,
  parseStepAnnotation,
  pixelRectToViewport,
  readPngSize,
  toGlobalBox,
  toLocalBox,
  viewportToPixelRect,
  zoomViewport,
} from "./annotation.ts";
import type { AnnotationTarget, NormalizedBox } from "./types.ts";

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

// ============================================================================
// crop-and-zoom（3周ループ）用の viewport 変換
// ============================================================================

test("isFullViewport: FULL_VIEWPORT は true、それ以外は false", () => {
  assert.equal(isFullViewport(FULL_VIEWPORT), true);
  assert.equal(isFullViewport({ x1: 125, y1: 0, x2: 875, y2: 1000 }), false);
});

test("toGlobalBox: viewport が FULL_VIEWPORT のときは恒等変換になる", () => {
  const local: NormalizedBox = { x1: 417, y1: 398, x2: 506, y2: 427 };
  const global = toGlobalBox(local, FULL_VIEWPORT);
  // 既存の parseStepAnnotation テスト（viewport 省略）が無改修で通る根拠となる性質
  assert.deepEqual(global, local);
});

test("toGlobalBox: 黒帯除去後の viewport（実測 crop=960:720:160:0 相当）で正しく変換する", () => {
  // 1280x720 のうち x=160〜1120 の 960x720 がコンテンツ領域 → 正規化で {125,0,875,1000}
  const viewport: NormalizedBox = { x1: 125, y1: 0, x2: 875, y2: 1000 };
  // 実測: 郵便番号欄付近を切り出した crop 画像内での応答例
  const local: NormalizedBox = { x1: 168, y1: 357, x2: 290, y2: 384 };
  const global = toGlobalBox(local, viewport);
  assert.equal(global.x1, 251); // 125 + (168*750)/1000
  assert.equal(global.y1, 357); // 0 + (357*1000)/1000
  assert.equal(global.x2, 342.5); // 125 + (290*750)/1000
  assert.equal(global.y2, 384);
});

test("toGlobalBox / toLocalBox: 往復変換の誤差が1未満", () => {
  const viewport: NormalizedBox = { x1: 200, y1: 100, x2: 700, y2: 900 };
  const original: NormalizedBox = { x1: 123, y1: 456, x2: 789, y2: 901 };
  const global = toGlobalBox(original, viewport);
  const roundTripped = toLocalBox(global, viewport);
  assert.ok(Math.abs(roundTripped.x1 - original.x1) < 1);
  assert.ok(Math.abs(roundTripped.y1 - original.y1) < 1);
  assert.ok(Math.abs(roundTripped.x2 - original.x2) < 1);
  assert.ok(Math.abs(roundTripped.y2 - original.y2) < 1);
});

test("viewportToPixelRect / pixelRectToViewport: 往復変換が安定する", () => {
  const v: NormalizedBox = { x1: 125, y1: 0, x2: 875, y2: 1000 };
  const rect = viewportToPixelRect(v, FRAME);
  assert.equal(rect.x, 160);
  assert.equal(rect.width, 960);
  assert.equal(rect.y, 0);
  assert.equal(rect.height, 720);

  const actual = pixelRectToViewport(rect, FRAME);
  assert.deepEqual(actual, v);
});

test("viewportToPixelRect: 偶数座標・偶数サイズに丸められる", () => {
  const v: NormalizedBox = { x1: 33, y1: 17, x2: 481, y2: 611 };
  const rect = viewportToPixelRect(v, FRAME);
  assert.equal(rect.x % 2, 0);
  assert.equal(rect.y % 2, 0);
  assert.equal(rect.width % 2, 0);
  assert.equal(rect.height % 2, 0);
});

test("contentViewportFromCropDetect: 実測の黒帯（crop=960:720:160:0）を正しく変換する", () => {
  const v = contentViewportFromCropDetect({ x: 160, y: 0, width: 960, height: 720 }, FRAME);
  assert.deepEqual(v, { x1: 125, y1: 0, x2: 875, y2: 1000 });
});

test("contentViewportFromCropDetect: 黒帯が無い（フレーム全体と一致）なら null", () => {
  const v = contentViewportFromCropDetect({ x: 0, y: 0, width: 1280, height: 720 }, FRAME);
  assert.equal(v, null);
});

test("contentViewportFromCropDetect: 面積比が小さすぎる検出（暗い映像の誤検出）は null", () => {
  // 1280x720 の 40% 未満の検出（MIN_CONTENT_AREA_RATIO=0.5 を下回る）
  const v = contentViewportFromCropDetect({ x: 400, y: 200, width: 400, height: 200 }, FRAME);
  assert.equal(v, null);
});

test("contentViewportFromCropDetect: フレーム外にはみ出す検出は null", () => {
  const v = contentViewportFromCropDetect({ x: 100, y: 0, width: 1200, height: 720 }, FRAME);
  assert.equal(v, null);
});

test("zoomViewport: box の周辺を拡大し、bounds をはみ出さない", () => {
  const box: NormalizedBox = { x1: 251, y1: 357, x2: 343, y2: 384 };
  const bounds: NormalizedBox = { x1: 125, y1: 0, x2: 875, y2: 1000 };
  const v = zoomViewport(box, bounds, FRAME);

  assert.ok(v.x1 >= bounds.x1 - 1); // 丸め誤差を許容
  assert.ok(v.y1 >= bounds.y1 - 1);
  assert.ok(v.x2 <= bounds.x2 + 1);
  assert.ok(v.y2 <= bounds.y2 + 1);
  // box を包含していること
  assert.ok(v.x1 <= box.x1);
  assert.ok(v.y1 <= box.y1);
  assert.ok(v.x2 >= box.x2);
  assert.ok(v.y2 >= box.y2);
});

test("zoomViewport: 画面端の box でも bounds 内に収まる", () => {
  const box: NormalizedBox = { x1: 130, y1: 5, x2: 180, y2: 40 }; // bounds の左上端に近い
  const bounds: NormalizedBox = { x1: 125, y1: 0, x2: 875, y2: 1000 };
  const v = zoomViewport(box, bounds, FRAME);
  assert.ok(v.x1 >= bounds.x1 - 1);
  assert.ok(v.y1 >= bounds.y1 - 1);
});

test("isPlausibleRefinement: 妥当な範囲の精緻化は受理する", () => {
  const prev: NormalizedBox = { x1: 300, y1: 256, x2: 407, y2: 274 };
  const next: NormalizedBox = { x1: 389, y1: 253, x2: 437, y2: 277 }; // 実測の正解に近い補正
  assert.equal(isPlausibleRefinement(prev, next), true);
});

test("isPlausibleRefinement: 面積が急に小さくなる（要素の一部だけを掴んだ）場合は棄却", () => {
  const prev: NormalizedBox = { x1: 654, y1: 252, x2: 777, y2: 279 }; // 123x27
  const next: NormalizedBox = { x1: 713, y1: 260, x2: 771, y2: 268 }; // 58x8、面積比 0.14
  assert.equal(isPlausibleRefinement(prev, next), false);
});

test("isPlausibleRefinement: 中心が大きく飛んだ場合は棄却", () => {
  const prev: NormalizedBox = { x1: 300, y1: 300, x2: 340, y2: 320 };
  const next: NormalizedBox = { x1: 800, y1: 700, x2: 840, y2: 720 }; // 別の要素に飛んだ
  assert.equal(isPlausibleRefinement(prev, next), false);
});

test("hasConverged: 中心の移動量が小さければ収束とみなす", () => {
  const prev: NormalizedBox = { x1: 300, y1: 250, x2: 400, y2: 280 };
  const next: NormalizedBox = { x1: 302, y1: 252, x2: 402, y2: 282 }; // ほぼ同じ位置
  assert.equal(hasConverged(prev, next), true);
});

test("hasConverged: 中心の移動量が大きければ未収束", () => {
  const prev: NormalizedBox = { x1: 300, y1: 250, x2: 400, y2: 280 };
  const next: NormalizedBox = { x1: 389, y1: 253, x2: 437, y2: 277 }; // 別の要素へ大きく移動
  assert.equal(hasConverged(prev, next), false);
});

test("parseStepAnnotation: viewport を指定すると、返る box は全体フレーム基準になる", () => {
  const viewport: NormalizedBox = { x1: 125, y1: 0, x2: 875, y2: 1000 };
  const raw = JSON.stringify({
    found: true,
    targets: [{ label: "〒→住所", kind: "button", bbox_2d: [168, 357, 290, 384] }],
  });
  const result = parseStepAnnotation(raw, FRAME, { viewport, maxTargets: 1 });
  assert.equal(result.ok, true);
  if (result.ok) {
    const box = result.annotation.targets[0].box;
    assert.equal(box.x1, 251);
    assert.equal(box.y1, 357);
    assert.equal(box.x2, 343); // 342.5 が Math.round で 343 に丸められる
    assert.equal(box.y2, 384);
  }
});

test("parseStepAnnotation: maxLocalAreaRatio で「切り出し領域全体」を返す退化を棄却する", () => {
  const viewport: NormalizedBox = { x1: 125, y1: 0, x2: 875, y2: 1000 };
  // crop 画像のほぼ全体を指す応答（全体座標に直すと面積比は小さく見えてしまう）
  const raw = JSON.stringify({
    found: true,
    targets: [{ label: "x", kind: "other", bbox_2d: [10, 10, 990, 990] }],
  });
  const result = parseStepAnnotation(raw, FRAME, { viewport, maxLocalAreaRatio: 0.5 });
  assert.deepEqual(result, { ok: false, reason: "no_valid_target" });
});
