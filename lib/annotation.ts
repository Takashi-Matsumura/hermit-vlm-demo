/**
 * スクリーンショット注釈サブエージェント（/api/manual/annotate）まわりの純粋関数。
 *
 * node:* も DOM API も使わない。サーバ（annotate route）・SVG オーバーレイ（AnnotatedFrame）・
 * Canvas 焼き込み（bakeAnnotatedPng）の3者が、座標計算をここ1箇所に集約して共有する。
 * import type しか使わないので `node --test` でバンドラ無しに実行できる。
 */
import type { AnnotationTarget, NormalizedBox, StepAnnotation } from "@/lib/types";

/** Qwen3-VL の bbox_2d が使う正規化座標の上限 */
const COORD_MAX = 1000;
/** 1手順に付ける注釈の上限。増やすほどモデルが枠を捏造しやすくなる */
const MAX_TARGETS = 4;
/** これより細い/低い枠は退化とみなして棄却する。1280x720 なら 10.2px x 5.8px 相当 */
const MIN_SIDE = 8;
/** 画面全体に対する面積比の上限。実測: ボタン0.23%・ドロップダウン0.26%・ダイアログ全体12%・ウィンドウ全体46% */
const MAX_AREA_RATIO = 0.15;
/** これ以上重なった枠は、同じ要素を2回返したとみなして後者を捨てる */
const MAX_IOU = 0.7;
const MAX_LABEL_LENGTH = 40;
const MAX_KIND_LENGTH = 20;

const KNOWN_KINDS = new Set([
  "button",
  "input",
  "dropdown",
  "checkbox",
  "menu",
  "tab",
  "link",
  "other",
]);

export type AnnotationParseResult =
  | { ok: true; annotation: StepAnnotation }
  | { ok: false; reason: "no_json" | "not_found" | "no_valid_target" };

type RawTarget = {
  label?: unknown;
  kind?: unknown;
  bbox_2d?: unknown;
};

type RawResponse = {
  found?: unknown;
  targets?: unknown;
};

/**
 * モデルの生テキストをパースし、妥当性検証を通った StepAnnotation を返す。
 *
 * 方針: 誤った枠を描くくらいなら描かない。範囲外座標・退化した枠・巨大すぎる枠は
 * クランプせずそのまま棄却する（クランプすると「それらしいが間違った位置」の枠を
 * 黙って描いてしまうため）。
 */
export function parseStepAnnotation(
  raw: string,
  frame: { width: number; height: number },
): AnnotationParseResult {
  // モデルが ```json フェンスや前置きを付けることがあるのでオブジェクト部分だけ取り出す
  // （lib/llm.ts の mergeManualSteps と同じ切り出し方）
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false, reason: "no_json" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { ok: false, reason: "no_json" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "no_json" };

  const { found, targets: rawTargets } = parsed as RawResponse;
  // found は厳密に true だけを通す。"true" / 1 / undefined はすべて対象なし扱い
  // （曖昧な値を通すのはハルシネーション側に倒すことになる）
  if (found !== true) return { ok: false, reason: "not_found" };
  if (!Array.isArray(rawTargets)) return { ok: false, reason: "not_found" };

  const accepted: AnnotationTarget[] = [];
  for (const item of rawTargets as RawTarget[]) {
    if (accepted.length >= MAX_TARGETS) break;
    const target = parseTarget(item);
    if (!target) continue;
    if (accepted.some((a) => iou(a.box, target.box) > MAX_IOU)) continue;
    accepted.push(target);
  }

  if (accepted.length === 0) return { ok: false, reason: "no_valid_target" };

  return {
    ok: true,
    annotation: { targets: accepted, frameWidth: frame.width, frameHeight: frame.height },
  };
}

function parseTarget(item: RawTarget): AnnotationTarget | null {
  if (typeof item !== "object" || item === null) return null;

  const box = parseBox(item.bbox_2d);
  if (!box) return null;

  const w = box.x2 - box.x1;
  const h = box.y2 - box.y1;
  if (w < MIN_SIDE || h < MIN_SIDE) return null;

  const areaRatio = (w * h) / (COORD_MAX * COORD_MAX);
  if (areaRatio > MAX_AREA_RATIO) return null;

  const label = typeof item.label === "string" ? item.label.trim().slice(0, MAX_LABEL_LENGTH) : "";
  const kindRaw = typeof item.kind === "string" ? item.kind.trim().slice(0, MAX_KIND_LENGTH) : "";
  const kind = KNOWN_KINDS.has(kindRaw) ? kindRaw : "other";

  return { label, kind, box };
}

function parseBox(raw: unknown): NormalizedBox | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const [a, b, c, d] = raw;
  if (![a, b, c, d].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  // 範囲外はクランプせず棄却する。x が 1000 を超える場合、モデルが正規化ではなく
  // 実ピクセルで返している可能性が高く、クランプすると誤った位置の枠を描いてしまう
  if ([a, b, c, d].some((n) => n < 0 || n > COORD_MAX)) return null;

  // 左右・上下が入れ替わっていることがあるので min/max で並べ直す
  const x1 = Math.min(a, c);
  const x2 = Math.max(a, c);
  const y1 = Math.min(b, d);
  const y2 = Math.max(b, d);
  return { x1, y1, x2, y2 };
}

function iou(a: NormalizedBox, b: NormalizedBox): number {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const interW = Math.max(0, x2 - x1);
  const interH = Math.max(0, y2 - y1);
  const inter = interW * interH;
  if (inter === 0) return 0;

  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  const union = areaA + areaB - inter;
  return union === 0 ? 0 : inter / union;
}

/** PNG の IHDR から幅・高さを読む。8バイトのシグネチャ + 8バイトのチャンクヘッダの直後 */
export function readPngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export const ANNOTATION_STYLE = {
  box: "#ef4444", // red-500。アプリの Tailwind パレットに合わせる
  halo: "rgba(255,255,255,0.92)",
  badgeFill: "#ef4444",
  badgeText: "#ffffff",
} as const;

export type AnnotationGeometry = {
  rect: { x: number; y: number; width: number; height: number };
  badge: { cx: number; cy: number; r: number; fontSize: number; text: string };
  strokeWidth: number;
  haloWidth: number;
};

/**
 * 正規化座標 [0,1000] を、フレームの実ピクセルに変換した描画用ジオメトリにする。
 * SVG オーバーレイと Canvas 焼き込みの両方がこの関数の出力をそのまま使うので、
 * 表示とエクスポートで枠の位置・太さが食い違うことがない。
 *
 * order は「その手順の中での操作順」（1始まり）。1画面で複数操作を続けて行う手順では、
 * mergeManualSteps が合成した後もこの番号だけが操作順を伝えられる。
 */
export function annotationGeometry(
  target: AnnotationTarget,
  order: number,
  frameWidth: number,
  frameHeight: number,
): AnnotationGeometry {
  const base = Math.min(frameWidth, frameHeight);
  const strokeWidth = Math.max(2, Math.round(base / 200));
  const haloWidth = strokeWidth + 3;
  const pad = Math.max(1, Math.round(base / 240));

  const toPx = (n: number, size: number) => (n / COORD_MAX) * size;

  const rawX1 = toPx(target.box.x1, frameWidth) - pad;
  const rawY1 = toPx(target.box.y1, frameHeight) - pad;
  const rawX2 = toPx(target.box.x2, frameWidth) + pad;
  const rawY2 = toPx(target.box.y2, frameHeight) + pad;

  const x = clamp(rawX1, 0, frameWidth);
  const y = clamp(rawY1, 0, frameHeight);
  const x2 = clamp(rawX2, 0, frameWidth);
  const y2 = clamp(rawY2, 0, frameHeight);

  const text = String(order);
  const r = Math.max(11, Math.round(base / 48));
  const fontSize = Math.round(r * (text.length >= 2 ? 1.05 : 1.35));
  const cx = clamp(x, r + 1, frameWidth - r - 1);
  const cy = clamp(y, r + 1, frameHeight - r - 1);

  return {
    rect: { x, y, width: x2 - x, height: y2 - y },
    badge: { cx, cy, r, fontSize, text },
    strokeWidth,
    haloWidth,
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
