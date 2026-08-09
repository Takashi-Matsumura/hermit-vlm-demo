"use client";

import { useCallback, useState } from "react";
import JSZip from "jszip";

import { formatTime, frameFileName, toManualMarkdown } from "@/lib/manual";
import type { ManualStepWithMeta } from "@/lib/types";

export default function ManualSteps({
  fileName,
  summary,
  steps,
  onSeek,
}: {
  fileName: string;
  summary: string;
  steps: ManualStepWithMeta[];
  onSeek: (time: number) => void;
}) {
  const [zipping, setZipping] = useState(false);

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
      await Promise.all(
        steps.map(async (step) => {
          try {
            const res = await fetch(step.imageUrl);
            if (!res.ok) throw new Error(`${step.imageUrl} が ${res.status} を返しました`);
            images?.file(frameFileName(step.imageUrl), await res.blob());
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

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-400">操作手順</h2>
        <button
          type="button"
          onClick={() => void download()}
          disabled={steps.length === 0 || zipping}
          className="rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white disabled:opacity-50"
        >
          {zipping ? "書き出しています…" : "ZIPで書き出す"}
        </button>
      </div>

      {steps.length === 0 ? (
        <p className="text-sm text-zinc-500">手順を生成しています…</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {steps.map((step, index) => (
            <li key={step.time}>
              <button
                type="button"
                onClick={() => onSeek(step.time)}
                className="flex w-full gap-4 rounded-lg p-2 text-left transition-colors hover:bg-zinc-800/70"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={step.imageUrl}
                  alt=""
                  className="h-20 w-32 shrink-0 rounded border border-zinc-800 object-cover"
                />
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="flex items-baseline gap-2">
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                      手順 {index + 1}
                    </span>
                    <span className="font-mono text-xs text-emerald-400">{formatTime(step.time)}</span>
                  </span>
                  <span className="text-sm font-medium text-zinc-100">{step.title}</span>
                  <span className="text-sm leading-6 text-zinc-300">{step.description}</span>
                </div>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
