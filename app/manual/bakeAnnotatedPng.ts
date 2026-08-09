/**
 * 注釈付きスクリーンショットを Canvas で PNG に焼き込む。DOM API（Image, Canvas）を
 * 使うので lib/ には置かない（lib/ はサーバの annotate route からも import されるため）。
 *
 * サーバ側 sharp + SVG composite ではなくブラウザの Canvas を選んだ理由は、
 * 番号バッジの数字描画をブラウザのフォントに任せられること。sharp の SVG composite は
 * Pango/fontconfig 依存で、フォント解決に失敗すると文字が黙って消える
 * （ffmpeg には drawtext＝freetype も無いので代替が無い）。
 */
import { ANNOTATION_STYLE, annotationGeometry } from "@/lib/annotation";
import type { StepAnnotation } from "@/lib/types";

export async function bakeAnnotatedPng(src: string, annotation: StepAnnotation): Promise<Blob> {
  const image = new Image();
  // /uploads/... は同一オリジンなので crossOrigin は付けない
  // （付けると CORS ヘッダが無いぶん読み込み自体が失敗する）。
  // 同一オリジンなので canvas は汚染されず toBlob が通る。
  image.src = src;
  await image.decode();

  const width = image.naturalWidth;
  const height = image.naturalHeight;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context を取得できませんでした");

  ctx.drawImage(image, 0, 0, width, height);
  ctx.lineJoin = "round";

  // annotation.frameWidth/Height ではなく実寸（naturalWidth/Height）で幾何を再計算する。
  // 枠は正規化座標なので、PNG を作り直して解像度が変わっても位置は合う。
  annotation.targets.forEach((target, i) => {
    const g = annotationGeometry(target, i + 1, width, height);

    ctx.strokeStyle = ANNOTATION_STYLE.halo;
    ctx.lineWidth = g.haloWidth;
    ctx.strokeRect(g.rect.x, g.rect.y, g.rect.width, g.rect.height);

    ctx.strokeStyle = ANNOTATION_STYLE.box;
    ctx.lineWidth = g.strokeWidth;
    ctx.strokeRect(g.rect.x, g.rect.y, g.rect.width, g.rect.height);

    ctx.beginPath();
    ctx.arc(g.badge.cx, g.badge.cy, g.badge.r, 0, Math.PI * 2);
    ctx.fillStyle = ANNOTATION_STYLE.badgeFill;
    ctx.fill();
    ctx.strokeStyle = ANNOTATION_STYLE.badgeText;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = ANNOTATION_STYLE.badgeText;
    ctx.font = `700 ${g.badge.fontSize}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(g.badge.text, g.badge.cx, g.badge.cy);
  });

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PNG への変換に失敗しました"));
    }, "image/png");
  });
}
