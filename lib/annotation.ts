/**
 * スクリーンショット注釈サブエージェント（/api/manual/annotate）まわりの純粋関数。
 *
 * node:* も DOM API も使わない。サーバ（annotate route）・SVG オーバーレイ（AnnotatedFrame）・
 * Canvas 焼き込み（bakeAnnotatedPng）の3者が、座標計算をここ1箇所に集約して共有する。
 * import type しか使わないので `node --test` でバンドラ無しに実行できる。
 *
 * crop-and-zoom による3周ループ（レターボックス除去 + 段階的な位置の絞り込み）を
 * 「viewport」という概念で統一的に扱う。viewport は「VLM に実際に見せた領域」を
 * 全体フレーム基準の正規化座標 [0,1000] で表したもの。
 *   - 1周目の viewport = レターボックスを除いたコンテンツ領域（無ければ全画面）
 *   - 2周目以降の viewport = 前周の box 周辺を拡大した領域
 * VLM が返す座標は常に「その viewport 画像を [0,1000] とするローカル座標」であり、
 * parseStepAnnotation の内部で toGlobalBox により全体座標へ変換してから外へ出す。
 * そのため AnnotationTarget.box は常に全体フレーム基準（既存の不変条件）のまま。
 */
import type { AnnotationTarget, NormalizedBox, PixelRect, StepAnnotation } from "@/lib/types";

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

export type ParseOptions = {
  /** VLM に見せた領域。既定は FULL_VIEWPORT（＝従来どおり全体フレームがそのまま座標系） */
  viewport?: NormalizedBox;
  /** 採用する target の上限。既定 MAX_TARGETS(4)。crop-and-zoom の2周目以降は 1 を渡す想定 */
  maxTargets?: number;
  /**
   * crop 画像に占める面積比（ローカル座標）の上限。既定なし（チェックしない）。
   * 拡大画像で「切り出した領域そのもの」を答えとして返す退化を弾くために、
   * 2周目以降だけ渡す。全体座標に直すと面積比 MAX_AREA_RATIO を下回ってすり抜けてしまうため、
   * ローカル座標のうちに見る必要がある。
   */
  maxLocalAreaRatio?: number;
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
  options?: ParseOptions,
): AnnotationParseResult {
  const viewport = options?.viewport ?? FULL_VIEWPORT;
  const maxTargets = options?.maxTargets ?? MAX_TARGETS;
  const maxLocalAreaRatio = options?.maxLocalAreaRatio;

  // モデルが ```json フェンスや前置きを付けることがあるのでオブジェクト部分だけ取り出す
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
    if (accepted.length >= maxTargets) break;
    const target = parseTarget(item, viewport, maxLocalAreaRatio);
    if (!target) continue;
    if (accepted.some((a) => boxIou(a.box, target.box) > MAX_IOU)) continue;
    accepted.push(target);
  }

  if (accepted.length === 0) return { ok: false, reason: "no_valid_target" };

  return {
    ok: true,
    annotation: { targets: accepted, frameWidth: frame.width, frameHeight: frame.height },
  };
}

function parseTarget(
  item: RawTarget,
  viewport: NormalizedBox,
  maxLocalAreaRatio: number | undefined,
): AnnotationTarget | null {
  if (typeof item !== "object" || item === null) return null;

  const localBox = parseBox(item.bbox_2d);
  if (!localBox) return null;

  // ---- ローカル座標系（VLM に実際に見せた viewport 画像基準）での検証 ----
  if (maxLocalAreaRatio !== undefined) {
    const lw = localBox.x2 - localBox.x1;
    const lh = localBox.y2 - localBox.y1;
    const localAreaRatio = (lw * lh) / (COORD_MAX * COORD_MAX);
    if (localAreaRatio > maxLocalAreaRatio) return null;
  }

  // ---- 全体フレーム座標系へ変換してから、既存の閾値で検証する ----
  // MIN_SIDE / MAX_AREA_RATIO の意味（フレーム全体に対する比率）を一切変えないため、
  // viewport が全画面（1周目・crop無し）でも拡大画像（2周目以降）でも同じ基準で判定できる。
  const box = roundBox(toGlobalBox(localBox, viewport));

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

export function boxIou(a: NormalizedBox, b: NormalizedBox): number {
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

// ============================================================================
// crop-and-zoom（3周ループ）用の viewport 変換
// ============================================================================

/** viewport が「全体フレームそのまま」を表す値。1周目・crop無しのときはこれを使う */
export const FULL_VIEWPORT: NormalizedBox = { x1: 0, y1: 0, x2: COORD_MAX, y2: COORD_MAX };

export function isFullViewport(v: NormalizedBox): boolean {
  return v.x1 === 0 && v.y1 === 0 && v.x2 === COORD_MAX && v.y2 === COORD_MAX;
}

function roundBox(box: NormalizedBox): NormalizedBox {
  return {
    x1: Math.round(box.x1),
    y1: Math.round(box.y1),
    x2: Math.round(box.x2),
    y2: Math.round(box.y2),
  };
}

/**
 * crop 画像内の正規化座標（ローカル座標）を、全体フレーム基準の正規化座標に戻す。
 *   global = viewport.x1 + local * (viewport.x2 - viewport.x1) / 1000
 * 掛け算を先にしてから割るのは浮動小数の丸めを避けるため
 * （(417/1000)*1000 は 417.00000000000006 になりうるが、(417*1000)/1000 は 417 になる）。
 * viewport が FULL_VIEWPORT のときはこの式が恒等変換になるので、
 * crop-and-zoom を使わない既存の呼び出しは1文字も挙動が変わらない。
 */
export function toGlobalBox(local: NormalizedBox, viewport: NormalizedBox): NormalizedBox {
  const vw = viewport.x2 - viewport.x1;
  const vh = viewport.y2 - viewport.y1;
  return {
    x1: viewport.x1 + (local.x1 * vw) / COORD_MAX,
    y1: viewport.y1 + (local.y1 * vh) / COORD_MAX,
    x2: viewport.x1 + (local.x2 * vw) / COORD_MAX,
    y2: viewport.y1 + (local.y2 * vh) / COORD_MAX,
  };
}

/** toGlobalBox の逆変換。テストの往復検証と、crop 領域からのはみ出し判定に使う */
export function toLocalBox(global: NormalizedBox, viewport: NormalizedBox): NormalizedBox {
  const vw = viewport.x2 - viewport.x1;
  const vh = viewport.y2 - viewport.y1;
  if (vw === 0 || vh === 0) return global;
  return {
    x1: ((global.x1 - viewport.x1) * COORD_MAX) / vw,
    y1: ((global.y1 - viewport.y1) * COORD_MAX) / vh,
    x2: ((global.x2 - viewport.x1) * COORD_MAX) / vw,
    y2: ((global.y2 - viewport.y1) * COORD_MAX) / vh,
  };
}

function toPx(n: number, size: number): number {
  return (n / COORD_MAX) * size;
}

function clampInt(n: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(n), min), max);
}

/** 2の倍数に切り下げる。ffmpeg の crop/scale フィルタチェーンでの丸め安定性のため */
function evenFloor(n: number): number {
  return n - (n % 2);
}

/** 2の倍数に切り上げる */
function evenCeil(n: number): number {
  return n % 2 === 0 ? n : n + 1;
}

/**
 * 正規化座標の矩形（viewport や box）を、PNG 実寸の整数ピクセル矩形にする。
 * ffmpeg の crop=W:H:X:Y にそのまま渡せる形（偶数座標・偶数サイズ）に丸める。
 */
export function viewportToPixelRect(v: NormalizedBox, frame: { width: number; height: number }): PixelRect {
  let x = clampInt(toPx(v.x1, frame.width), 0, frame.width);
  let y = clampInt(toPx(v.y1, frame.height), 0, frame.height);
  let x2 = clampInt(toPx(v.x2, frame.width), 0, frame.width);
  let y2 = clampInt(toPx(v.y2, frame.height), 0, frame.height);

  x = evenFloor(x);
  y = evenFloor(y);
  x2 = evenCeil(x2);
  y2 = evenCeil(y2);

  const width = evenFloor(Math.max(2, Math.min(x2 - x, frame.width - x)));
  const height = evenFloor(Math.max(2, Math.min(y2 - y, frame.height - y)));

  return { x, y, width, height };
}

/**
 * 実際に ffmpeg で切り出したピクセル矩形から viewport を作り直す。
 * viewportToPixelRect で丸めた rect をそのまま逆変換に使うことで、
 * 「意図した viewport」と「実際に切った画像」のズレ（丸め誤差）を座標変換に持ち込まない。
 * 呼び出し側は必ず `const rect = viewportToPixelRect(v, size); const actual = pixelRectToViewport(rect, size);`
 * の順で使うこと。
 */
export function pixelRectToViewport(r: PixelRect, frame: { width: number; height: number }): NormalizedBox {
  return {
    x1: (r.x / frame.width) * COORD_MAX,
    y1: (r.y / frame.height) * COORD_MAX,
    x2: ((r.x + r.width) / frame.width) * COORD_MAX,
    y2: ((r.y + r.height) / frame.height) * COORD_MAX,
  };
}

/** ズーム領域を決める際の既定パラメータ（実測に基づく） */
const ZOOM_MARGIN_RATIO = 1.5;
/**
 * 切り出す幅の下限（bounds 幅に対する比）。
 * 実測: 2周目にこの比率で拡大すると誤差中央値が 27.6px → 11.4px に改善した。
 * 3周目にさらに拡大（0.15 相当）すると 20.5px へ悪化したため、
 * 3周目も同じ 0.30 を使い「拡大率を上げない確認パス」にする。
 */
const ZOOM_MIN_WIDTH_RATIO = 0.3;

/**
 * box の周辺を拡大するズーム領域（次の viewport 候補）を決める。
 * 必ずピクセル空間で計算する。正規化座標 [0,1000]² は動画のアスペクト比によって
 * 非等方（1280x720 なら x:y は 1.28:0.72 相当）なので、正規化空間のまま縦横比を
 * 調整すると画像が歪んでしまう。
 */
export function zoomViewport(
  box: NormalizedBox,
  bounds: NormalizedBox,
  frame: { width: number; height: number },
  opts?: { marginRatio?: number; minWidthRatio?: number },
): NormalizedBox {
  const marginRatio = opts?.marginRatio ?? ZOOM_MARGIN_RATIO;
  const minWidthRatio = opts?.minWidthRatio ?? ZOOM_MIN_WIDTH_RATIO;

  const boxPx = viewportToPixelRect(box, frame);
  const boundsPx = viewportToPixelRect(bounds, frame);

  const bw = Math.max(1, boxPx.width);
  const bh = Math.max(1, boxPx.height);

  let w = Math.max(bw * (1 + 2 * marginRatio), boundsPx.width * minWidthRatio);
  // bounds と同じ縦横比を保つ（「普通のスクリーンショットに見える」形にする）
  let h = (w * boundsPx.height) / boundsPx.width;

  if (h < bh * (1 + 2 * marginRatio)) {
    h = bh * (1 + 2 * marginRatio);
    w = (h * boundsPx.width) / boundsPx.height;
  }

  // bounds のサイズで上限クランプ
  w = Math.min(w, boundsPx.width);
  h = Math.min(h, boundsPx.height);

  // box の中心に合わせて配置する
  const cx = boxPx.x + bw / 2;
  const cy = boxPx.y + bh / 2;
  let x = cx - w / 2;
  let y = cy - h / 2;

  // bounds をはみ出す分は、倍率を保ったまま内側へ寄せる（縮めない）
  x = Math.max(boundsPx.x, Math.min(x, boundsPx.x + boundsPx.width - w));
  y = Math.max(boundsPx.y, Math.min(y, boundsPx.y + boundsPx.height - h));

  const rect: PixelRect = {
    x: evenFloor(clampInt(x, 0, frame.width)),
    y: evenFloor(clampInt(y, 0, frame.height)),
    width: evenFloor(Math.min(Math.max(2, w), frame.width)),
    height: evenFloor(Math.min(Math.max(2, h), frame.height)),
  };

  return pixelRectToViewport(rect, frame);
}

/** cropdetect の検出結果を、誤検出とみなして無視する面積比のしきい値 */
const MIN_CONTENT_AREA_RATIO = 0.5;

/**
 * ffmpeg cropdetect の結果（動画実寸のピクセル矩形）を正規化 viewport にする。
 * 黒帯が無い動画・検出が怪しい（フレームより小さすぎる/はみ出す）場合は null を返す。
 * 黒帯検出は精度改善のための最適化であって、失敗しても従来どおり動くべき性質のもの
 * （呼び出し側は null を FULL_VIEWPORT として扱う）。
 */
export function contentViewportFromCropDetect(
  rect: PixelRect,
  video: { width: number; height: number },
): NormalizedBox | null {
  if (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height)
  ) {
    return null;
  }
  if (rect.width <= 0 || rect.height <= 0) return null;
  if (rect.x < 0 || rect.y < 0) return null;
  if (rect.x + rect.width > video.width || rect.y + rect.height > video.height) return null;

  const isFullFrame = rect.x === 0 && rect.y === 0 && rect.width === video.width && rect.height === video.height;
  if (isFullFrame) return null; // 黒帯なし。何もしない

  const areaRatio = (rect.width * rect.height) / (video.width * video.height);
  if (areaRatio < MIN_CONTENT_AREA_RATIO) return null; // 暗い映像等の誤検出の疑い

  return pixelRectToViewport(rect, video);
}

/** 拡大後の枠を受理してよいかの判定に使う定数（実測に基づく） */
const MIN_REFINE_AREA_RATIO = 0.4;
const MAX_REFINE_AREA_RATIO = 2.5;
/** 中心の移動量の上限（前周の box の対角長に対する比） */
const MAX_REFINE_SHIFT_RATIO = 1.5;

/**
 * crop-and-zoom で新しく得た枠 next が、前周の枠 prev の「精緻化」として尤もらしいかを判定する。
 * 拡大画像で要素の一部だけを掴んだ（面積が急に小さくなる）、あるいは切り出し領域全体を
 * 指してしまった（面積が急に大きくなる）、対象を見失って無関係な位置に飛んだ（中心が大きくずれる）
 * といった退化を検出し、その場合は前周の枠を維持させる。
 */
export function isPlausibleRefinement(prev: NormalizedBox, next: NormalizedBox): boolean {
  const prevArea = (prev.x2 - prev.x1) * (prev.y2 - prev.y1);
  const nextArea = (next.x2 - next.x1) * (next.y2 - next.y1);
  if (prevArea <= 0) return true; // 前周が退化している場合はこの判定基準が使えないので通す

  const areaRatio = nextArea / prevArea;
  if (areaRatio < MIN_REFINE_AREA_RATIO || areaRatio > MAX_REFINE_AREA_RATIO) return false;

  const prevCx = (prev.x1 + prev.x2) / 2;
  const prevCy = (prev.y1 + prev.y2) / 2;
  const nextCx = (next.x1 + next.x2) / 2;
  const nextCy = (next.y1 + next.y2) / 2;
  const shift = Math.hypot(nextCx - prevCx, nextCy - prevCy);
  const diag = Math.hypot(prev.x2 - prev.x1, prev.y2 - prev.y1);
  if (diag === 0) return true;

  return shift / diag <= MAX_REFINE_SHIFT_RATIO;
}

/** 収束判定に使う、中心移動量の許容比（前周 box の長辺に対する比） */
const CONVERGE_SHIFT_RATIO = 0.2;

/**
 * 周回を打ち切ってよいか（十分収束したか）を判定する。
 * IoU は使わない: crop-and-zoom は周を追うごとに枠が「太い当たり」から「要素ぴったり」へ
 * 締まっていく性質上、位置が合っていても IoU が低く出る（実測で周回間 0.11〜0.81）。
 * 代わりに中心の移動量で判定する。
 */
export function hasConverged(prev: NormalizedBox, next: NormalizedBox): boolean {
  const prevCx = (prev.x1 + prev.x2) / 2;
  const prevCy = (prev.y1 + prev.y2) / 2;
  const nextCx = (next.x1 + next.x2) / 2;
  const nextCy = (next.y1 + next.y2) / 2;
  const shift = Math.hypot(nextCx - prevCx, nextCy - prevCy);
  const longSide = Math.max(prev.x2 - prev.x1, prev.y2 - prev.y1);
  if (longSide === 0) return true;

  return shift / longSide <= CONVERGE_SHIFT_RATIO;
}
