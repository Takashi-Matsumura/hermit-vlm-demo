/**
 * 注釈付きスクリーンショットを SVG に焼き込む。元画像は data URI として埋め込み、
 * 赤枠・番号バッジは <rect>/<circle>/<text> のベクター要素のまま出力する。
 *
 * 従来の Canvas 焼き込みと違い、書き出した SVG を Illustrator や Inkscape で開くと
 * 注釈だけを個別に選択・移動・削除・色変更できる（背景のスクリーンショット自体はラスタのまま）。
 *
 * DOM API（Image, FileReader）を使うので lib/ には置かない
 * （lib/ はサーバの annotate route からも import されるため）。
 */
import { ANNOTATION_STYLE, annotationGeometry } from "@/lib/annotation";
import type { StepAnnotation } from "@/lib/types";

export async function bakeAnnotatedSvg(src: string, annotation: StepAnnotation): Promise<Blob> {
  // /uploads/... は同一オリジンなので crossOrigin は付けない
  const res = await fetch(src);
  if (!res.ok) throw new Error(`${src} が ${res.status} を返しました`);
  const dataUri = await blobToDataUrl(await res.blob());

  const image = new Image();
  image.src = dataUri;
  await image.decode();
  const width = image.naturalWidth;
  const height = image.naturalHeight;

  // annotation.frameWidth/Height ではなく実寸で幾何を再計算する。
  // 枠は正規化座標なので、フレーム PNG を作り直して解像度が変わっても位置は合う。
  const overlays = annotation.targets
    .map((target, i) => overlayMarkup(annotationGeometry(target, i + 1, width, height)))
    .join("\n");

  const svg = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `  <image x="0" y="0" width="${width}" height="${height}" href="${dataUri}" />`,
    overlays,
    "</svg>",
    "",
  ].join("\n");

  return new Blob([svg], { type: "image/svg+xml" });
}

function overlayMarkup(g: ReturnType<typeof annotationGeometry>): string {
  const { rect, badge, strokeWidth, haloWidth } = g;
  return [
    rectMarkup(rect, ANNOTATION_STYLE.halo, haloWidth),
    rectMarkup(rect, ANNOTATION_STYLE.box, strokeWidth),
    `<circle cx="${badge.cx}" cy="${badge.cy}" r="${badge.r}" fill="${ANNOTATION_STYLE.badgeFill}" stroke="${ANNOTATION_STYLE.badgeText}" stroke-width="2" />`,
    `<text x="${badge.cx}" y="${badge.cy}" fill="${ANNOTATION_STYLE.badgeText}" font-size="${badge.fontSize}" font-weight="700" font-family="system-ui, -apple-system, sans-serif" text-anchor="middle" dominant-baseline="central">${escapeXml(badge.text)}</text>`,
  ].join("\n");
}

function rectMarkup(
  r: { x: number; y: number; width: number; height: number },
  stroke: string,
  strokeWidth: number,
): string {
  return `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round" />`;
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("画像の読み込みに失敗しました"));
    reader.readAsDataURL(blob);
  });
}
