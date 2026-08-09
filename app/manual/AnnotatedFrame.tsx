"use client";

import { ANNOTATION_STYLE, annotationGeometry } from "@/lib/annotation";
import type { StepAnnotation } from "@/lib/types";

/**
 * スクリーンショット PNG に、注釈サブエージェント（/api/manual/annotate）が
 * 特定した対象を SVG オーバーレイで描き足す。
 *
 * 座標計算は lib/annotation.ts の annotationGeometry に一本化してあるので、
 * ここでの責務は「その結果をどう描くか」だけ。ZIP エクスポート側の
 * bakeAnnotatedPng（Canvas 焼き込み）も同じ関数を使うので、画面表示と
 * エクスポートで枠の位置・太さが食い違うことはない。
 *
 * compact（一覧サムネ用）: 太さを画面ピクセル固定にし、バッジは描かない
 * （30pxのバッジ円がサムネの縮小率では3pxになり読めなくなるため）。
 */
export default function AnnotatedFrame({
  src,
  alt,
  annotation,
  compact = false,
  fit = "cover",
  className,
}: {
  src: string;
  alt: string;
  annotation: StepAnnotation | undefined;
  compact?: boolean;
  fit?: "cover" | "contain";
  className?: string;
}) {
  const objectFitClass = fit === "cover" ? "object-cover" : "object-contain";

  return (
    <span className={`relative block overflow-hidden ${className ?? ""}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className={`block h-full w-full ${objectFitClass}`} />

      {annotation && annotation.frameWidth > 0 && annotation.frameHeight > 0 && (
        <svg
          viewBox={`0 0 ${annotation.frameWidth} ${annotation.frameHeight}`}
          // img と同じ規則（cover→slice / contain→meet）で収めることで、表示サイズが
          // 何であっても SVG のユーザー空間が img の描画内容に1対1で張り付く
          preserveAspectRatio={fit === "cover" ? "xMidYMid slice" : "xMidYMid meet"}
          className="pointer-events-none absolute inset-0 h-full w-full"
          aria-hidden="true"
        >
          {annotation.targets.map((target, i) => {
            const g = annotationGeometry(target, i + 1, annotation.frameWidth, annotation.frameHeight);
            return (
              <g key={i}>
                <rect
                  x={g.rect.x}
                  y={g.rect.y}
                  width={g.rect.width}
                  height={g.rect.height}
                  fill="none"
                  stroke={ANNOTATION_STYLE.halo}
                  strokeWidth={compact ? 3 : g.haloWidth}
                  vectorEffect={compact ? "non-scaling-stroke" : undefined}
                />
                <rect
                  x={g.rect.x}
                  y={g.rect.y}
                  width={g.rect.width}
                  height={g.rect.height}
                  fill="none"
                  stroke={ANNOTATION_STYLE.box}
                  strokeWidth={compact ? 1.5 : g.strokeWidth}
                  vectorEffect={compact ? "non-scaling-stroke" : undefined}
                />
                {!compact && (
                  <>
                    <circle
                      cx={g.badge.cx}
                      cy={g.badge.cy}
                      r={g.badge.r}
                      fill={ANNOTATION_STYLE.badgeFill}
                      stroke={ANNOTATION_STYLE.badgeText}
                      strokeWidth={2}
                    />
                    <text
                      x={g.badge.cx}
                      y={g.badge.cy}
                      fill={ANNOTATION_STYLE.badgeText}
                      fontSize={g.badge.fontSize}
                      fontWeight={700}
                      textAnchor="middle"
                      dominantBaseline="central"
                    >
                      {g.badge.text}
                    </text>
                  </>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </span>
  );
}
