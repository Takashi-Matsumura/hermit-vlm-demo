"use client";

import { useCallback, useState } from "react";
import JSZip from "jszip";

import { formatTime, stepImageFileName, toManualMarkdown } from "@/lib/manual";
import type { ManualStepWithMeta } from "@/lib/types";

import AnnotatedFrame from "./AnnotatedFrame";
import { bakeAnnotatedPng } from "./bakeAnnotatedPng";

export default function ManualSteps({
  fileName,
  summary,
  steps,
  onSeek,
  annotating,
  annotateProgress,
  onReannotate,
}: {
  fileName: string;
  summary: string;
  steps: ManualStepWithMeta[];
  onSeek: (time: number) => void;
  /** スクリーンショット注釈サブエージェント（/api/manual/annotate）が実行中かどうか */
  annotating: boolean;
  annotateProgress: { done: number; total: number };
  onReannotate: () => void;
}) {
  const [zipping, setZipping] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const download = useCallback(async () => {
    setZipping(true);
    try {
      const base = fileName.replace(/\.[^.]+$/, "") || "manual";
      const markdown = toManualMarkdown({ title: `${base} の操作手順`, summary, steps });

      const zip = new JSZip();
      zip.file(`${base}.md`, markdown);
      const images = zip.folder("images");

      // 画像は同一オリジンの /uploads/<id>/frames/*.png なので fetch できる。
      // 1枚取得に失敗しても他の画像・Markdown本体は諦めずに ZIP に含める。
      // 注釈があれば Canvas で焼き込んだものを入れ、焼き込みに失敗したら元画像にフォールバックする
      // （Markdown の画像リンクを死なせないことを最優先する）。
      await Promise.all(
        steps.map(async (step, index) => {
          const name = stepImageFileName(step, index);
          try {
            if (step.annotation) {
              try {
                images?.file(name, await bakeAnnotatedPng(step.imageUrl, step.annotation));
                return;
              } catch (error) {
                console.error(`[manual] 注釈の焼き込みに失敗しました（${step.imageUrl}）:`, error);
              }
            }
            const res = await fetch(step.imageUrl);
            if (!res.ok) throw new Error(`${step.imageUrl} が ${res.status} を返しました`);
            images?.file(name, await res.blob());
          } catch (error) {
            console.error(`[manual] 画像の取得に失敗しました（${step.imageUrl}）:`, error);
          }
        }),
      );

      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      // パスに使えない文字だけ落とす（日本語のファイル名はそのまま残す）
      a.download = `${base.replace(/[\\/:*?"<>|]/g, "_")}.zip`;
      a.click();
      // click() の直後に revoke するとダウンロードが始まらないブラウザがあるので1tick待つ
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } finally {
      setZipping(false);
    }
  }, [fileName, steps, summary]);

  const lightboxStep = lightboxIndex !== null ? steps[lightboxIndex] : undefined;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-zinc-400">操作手順</h2>
        <div className="flex items-center gap-2">
          {annotating ? (
            <span className="text-xs text-zinc-500">
              注釈サブエージェント実行中… {annotateProgress.done} / {annotateProgress.total}
            </span>
          ) : (
            steps.length > 0 && (
              <button
                type="button"
                onClick={onReannotate}
                className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-800"
              >
                注釈をやり直す
              </button>
            )
          )}
          <button
            type="button"
            onClick={() => void download()}
            disabled={steps.length === 0 || zipping}
            className="rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white disabled:opacity-50"
          >
            {zipping ? "書き出しています…" : "ZIPで書き出す"}
          </button>
        </div>
      </div>

      {steps.length === 0 ? (
        <p className="text-sm text-zinc-500">手順を生成しています…</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {steps.map((step, index) => (
            <li
              key={`${index}-${step.time}`}
              className="flex gap-4 rounded-lg p-2 transition-colors hover:bg-zinc-800/70"
            >
              {/* 画像クリック=拡大、行クリック=動画シーク、と役割を分ける */}
              <button
                type="button"
                onClick={() => setLightboxIndex(index)}
                className="shrink-0"
                aria-label={`手順${index + 1}のスクリーンショットを拡大`}
              >
                <AnnotatedFrame
                  src={step.imageUrl}
                  alt=""
                  annotation={step.annotation}
                  compact
                  fit="contain"
                  className="h-20 w-32 rounded border border-zinc-800"
                />
              </button>
              <button
                type="button"
                onClick={() => onSeek(step.time)}
                className="flex min-w-0 flex-1 flex-col gap-1 text-left"
              >
                <span className="flex items-baseline gap-2">
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                    手順 {index + 1}
                  </span>
                  <span className="font-mono text-xs text-emerald-400">{formatTime(step.time)}</span>
                </span>
                <span className="text-sm font-medium text-zinc-100">{step.title}</span>
                <span className="text-sm leading-6 text-zinc-300">{step.description}</span>
              </button>
            </li>
          ))}
        </ol>
      )}

      {lightboxStep && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
          onClick={() => setLightboxIndex(null)}
        >
          <div className="flex max-h-full max-w-3xl flex-col gap-3" onClick={(e) => e.stopPropagation()}>
            {lightboxStep.annotation ? (
              <div
                className="relative w-full"
                style={{
                  aspectRatio: `${lightboxStep.annotation.frameWidth} / ${lightboxStep.annotation.frameHeight}`,
                }}
              >
                <AnnotatedFrame
                  src={lightboxStep.imageUrl}
                  alt=""
                  annotation={lightboxStep.annotation}
                  fit="contain"
                  className="h-full w-full rounded-lg border border-zinc-700"
                />
              </div>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={lightboxStep.imageUrl}
                alt=""
                className="max-h-[80vh] w-auto rounded-lg border border-zinc-700"
              />
            )}
            <button
              type="button"
              onClick={() => setLightboxIndex(null)}
              className="self-start rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-800"
            >
              閉じる
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
