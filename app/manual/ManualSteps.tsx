"use client";

import { useCallback } from "react";

import { formatTime, toManualMarkdown } from "@/lib/manual";
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
  const download = useCallback(() => {
    const base = fileName.replace(/\.[^.]+$/, "") || "manual";
    const markdown = toManualMarkdown({
      title: `${base} の操作手順`,
      summary,
      steps,
      origin: window.location.origin,
    });

    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    // パスに使えない文字だけ落とす（日本語のファイル名はそのまま残す）
    a.download = `${base.replace(/[\\/:*?"<>|]/g, "_")}.md`;
    a.click();
    // click() の直後に revoke するとダウンロードが始まらないブラウザがあるので1tick待つ
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [fileName, steps, summary]);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-400">操作手順</h2>
        <button
          type="button"
          onClick={download}
          disabled={steps.length === 0}
          className="rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white disabled:opacity-50"
        >
          Markdownで書き出す
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
