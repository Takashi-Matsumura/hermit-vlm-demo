"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";

import { formatTime } from "@/lib/manual";
import { readSse } from "@/lib/sse";
import type {
  ManualAnalyzeEvent,
  ManualAnnotateEvent,
  ManualStepWithMeta,
  ManualVerifyEvent,
  SearchHit,
  Utterance,
} from "@/lib/types";

import ManualSteps from "./ManualSteps";
import QaChat from "./QaChat";

type FrameItem = { time: number; text: string; imageUrl: string; fromUtterance: boolean };

type Status = "idle" | "analyzing" | "done" | "error";

export default function ManualPage() {
  const [status, setStatus] = useState<Status>("idle");
  const [fileName, setFileName] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [dragging, setDragging] = useState(false);

  const [analysisId, setAnalysisId] = useState<string>("");
  const [videoUrl, setVideoUrl] = useState<string>("");
  const [duration, setDuration] = useState<number>(0);
  const [frameCount, setFrameCount] = useState<number>(0);
  const [utteranceCount, setUtteranceCount] = useState<number>(0);
  const [utteranceFrameCount, setUtteranceFrameCount] = useState<number>(0);

  const [frames, setFrames] = useState<FrameItem[]>([]);
  const [summary, setSummary] = useState<string>("");
  const [steps, setSteps] = useState<ManualStepWithMeta[]>([]);
  const [utterances, setUtterances] = useState<Utterance[]>([]);

  const [query, setQuery] = useState<string>("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const [annotating, setAnnotating] = useState(false);
  const [annotateProgress, setAnnotateProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });

  const [verifying, setVerifying] = useState(false);
  const [verifyProgress, setVerifyProgress] = useState<{ round: number; done: number; total: number }>({
    round: 0,
    done: 0,
    total: 0,
  });

  const videoRef = useRef<HTMLVideoElement>(null);
  // annotate の SSE が別の動画に切り替わった後まで届いた場合に、無関係な steps を
  // 上書きしないためのガード（新しい analyze が始まるたびに更新する）
  const activeIdRef = useRef<string>("");

  const seekTo = useCallback((time: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = time;
    void video.play();
  }, []);

  /**
   * スクリーンショット注釈サブエージェントを起動する。手順が確定した result.json が
   * 既にサーバにある前提（analyze の done イベント後に呼ぶ）なので、id だけで動く。
   * 失敗してもマニュアル本体（手順・ZIP）はそのまま使えるので、エラーはログに残すだけにする。
   */
  const annotate = useCallback(async (id: string) => {
    setAnnotating(true);
    setAnnotateProgress({ done: 0, total: 0 });

    try {
      const res = await fetch("/api/manual/annotate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.body) throw new Error("レスポンスが空です");

      await readSse<ManualAnnotateEvent>(res.body, (event) => {
        // 待っている間に別の動画の解析が始まっていたら、この結果は捨てる
        if (activeIdRef.current !== id) return;

        switch (event.type) {
          case "start":
            setAnnotateProgress({ done: 0, total: event.total });
            break;
          case "annotation":
            setAnnotateProgress((prev) => ({ ...prev, done: prev.done + 1 }));
            // index で突合する（time ではない）。手順統合に失敗したグループでは
            // 同じ time の手順が複数残りうるため
            setSteps((prev) =>
              prev.map((step, i) =>
                i === event.index ? { ...step, annotation: event.annotation ?? undefined } : step,
              ),
            );
            break;
          case "done":
          case "error":
            break;
        }
      });
    } catch (e) {
      console.error("[manual] 注釈の生成に失敗しました:", e);
    } finally {
      if (activeIdRef.current === id) setAnnotating(false);
    }
  }, []);

  /**
   * スクリーンショット検証サブエージェントを起動する。手順の説明文と画像が
   * 食い違っている場合、動画から新規フレームを抽出して差し替える（最大3周ループ）。
   * 完了後に注釈サブエージェントを起動する（画像が確定してから赤枠を付けるため。
   * 差し替えが起きた手順は verify 側で古い注釈を無効化済み）。
   */
  const verify = useCallback(
    async (id: string) => {
      setVerifying(true);
      setVerifyProgress({ round: 0, done: 0, total: 0 });

      try {
        const res = await fetch("/api/manual/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        if (!res.body) throw new Error("レスポンスが空です");

        await readSse<ManualVerifyEvent>(res.body, (event) => {
          if (activeIdRef.current !== id) return;

          switch (event.type) {
            case "round-start":
              setVerifyProgress({ round: event.round, done: 0, total: event.targets });
              break;
            case "verification":
              setVerifyProgress((prev) => ({ ...prev, done: prev.done + 1 }));
              // index で突合する（time ではない。annotate と同じ理由）
              setSteps((prev) =>
                prev.map((step, i) =>
                  i === event.index
                    ? {
                        ...step,
                        time: event.replacedTime ?? step.time,
                        imageUrl: event.replacedImageUrl ?? step.imageUrl,
                        // 画像が変わったら古い注釈（赤枠）はもう合わないので消す
                        annotation: event.replacedImageUrl ? undefined : step.annotation,
                        verification: event.verification,
                      }
                    : step,
                ),
              );
              break;
            case "round-done":
            case "done":
            case "error":
              break;
          }
        });
      } catch (e) {
        console.error("[manual] スクリーンショットの検証に失敗しました:", e);
      } finally {
        if (activeIdRef.current === id) setVerifying(false);
      }

      // verify が失敗しても、まだ意味のあるスクリーンショットには注釈を付けたいので続行する
      void annotate(id);
    },
    [annotate],
  );

  const analyze = useCallback(async (file: File) => {
    setStatus("analyzing");
    setFileName(file.name);
    setError("");
    setFrames([]);
    setSummary("");
    setSteps([]);
    setUtterances([]);
    setHits(null);
    setFrameCount(0);
    setDuration(0);
    setUtteranceCount(0);
    setUtteranceFrameCount(0);
    // 前の動画のサブエージェントがまだ走っていても、その結果は新しい動画に適用しない
    activeIdRef.current = "";
    setVerifying(false);
    setVerifyProgress({ round: 0, done: 0, total: 0 });
    setAnnotating(false);
    setAnnotateProgress({ done: 0, total: 0 });

    const formData = new FormData();
    formData.append("video", file);

    try {
      const res = await fetch("/api/manual/analyze", { method: "POST", body: formData });
      if (!res.body) throw new Error("レスポンスが空です");

      await readSse<ManualAnalyzeEvent>(res.body, (event) => {
        switch (event.type) {
          case "info":
            activeIdRef.current = event.id;
            setAnalysisId(event.id);
            setVideoUrl(event.videoUrl);
            setDuration(event.duration);
            setFrameCount(event.frameCount);
            setUtteranceCount(event.utteranceCount);
            setUtteranceFrameCount(event.utteranceFrameCount);
            break;
          case "caption":
            setFrames((prev) => [
              ...prev,
              {
                time: event.time,
                text: event.text,
                imageUrl: event.imageUrl,
                fromUtterance: event.fromUtterance,
              },
            ]);
            break;
          case "utterances":
            setUtterances(event.utterances);
            break;
          case "summary":
            setSummary(event.text);
            break;
          case "steps":
            setSteps(event.steps);
            break;
          case "done":
            setStatus("done");
            // result.json は route.ts 側で書き終わってから done が送られるので、
            // このタイミングなら verify（この後 annotate も）から必ず読める
            void verify(event.id);
            break;
          case "error":
            setError(event.message);
            setStatus("error");
            break;
        }
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [verify]);

  /** 「注釈をやり直す」ボタン用。実行中の多重起動は防ぐ（スロットを食い潰さないため） */
  const reannotate = useCallback(() => {
    if (!analysisId || annotating) return;
    void annotate(analysisId);
  }, [analysisId, annotating, annotate]);

  /** 「検証をやり直す」ボタン用。verify は完了後に annotate も起動する */
  const reverify = useCallback(() => {
    if (!analysisId || verifying || annotating) return;
    void verify(analysisId);
  }, [analysisId, verifying, annotating, verify]);

  const search = useCallback(async () => {
    if (!query.trim() || !analysisId) return;
    setSearching(true);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: analysisId, query }),
      });
      const data = (await res.json()) as { hits?: SearchHit[]; error?: string };
      setHits(data.hits ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  }, [analysisId, query]);

  // ドロップゾーンの外にファイルを落とすと、ブラウザが動画を開いて画面が飛んでしまう
  useEffect(() => {
    const prevent = (e: globalThis.DragEvent) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  const pickFile = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      if (!file.type.startsWith("video/")) {
        setFileName(file.name);
        setError("動画ファイルではありません");
        setStatus("error");
        return;
      }
      void analyze(file);
    },
    [analyze],
  );

  const handleDrop = useCallback(
    (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      setDragging(false);
      pickFile(e.dataTransfer.files[0]);
    },
    [pickFile],
  );

  const analyzing = status === "analyzing";

  const statusLine = analyzing
    ? frameCount === 0
      ? "音声を文字起こししています…"
      : frames.length < frameCount
        ? `画面を解析中… ${frames.length} / ${frameCount} フレーム`
        : "手順をまとめています…"
    : status === "error"
      ? "解析に失敗しました"
      : [
          duration > 0 && `${duration.toFixed(1)}秒`,
          frameCount > 0 &&
            `${frameCount}フレーム（うち発話区切れ ${utteranceFrameCount}）`,
          utteranceCount > 0 && `発話 ${utteranceCount}件`,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <div className="min-h-screen bg-zinc-950 font-sans text-zinc-100">
      <main className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-12">
        <header className="flex flex-col gap-2">
          <Link
            href="/"
            className="w-fit text-xs text-zinc-500 underline decoration-dotted hover:text-zinc-300"
          >
            ← 動画言語化デモ
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight">操作マニュアル自動生成</h1>
          <p className="text-sm text-zinc-400">
            操作画面の録画とナレーションから手順書を作ります。
          </p>
        </header>

        {status === "idle" ? (
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              className={`flex cursor-pointer flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-14 transition-colors ${
                dragging
                  ? "border-emerald-500 bg-emerald-950/30"
                  : "border-zinc-700 hover:border-zinc-500 hover:bg-zinc-900"
              }`}
            >
              <svg
                className={`h-10 w-10 transition-colors ${dragging ? "text-emerald-400" : "text-zinc-600"}`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <rect x="2" y="5" width="20" height="14" rx="2" />
                <path d="m10 9.5 5 2.5-5 2.5z" fill="currentColor" stroke="none" />
              </svg>
              <span className="text-sm text-zinc-300">
                {dragging
                  ? "ここにドロップ"
                  : "操作を声で説明しながら録画した画面録画をドロップ"}
              </span>
              <span className="text-xs text-zinc-500">
                発話の区切れ目でも画面を切り出すので、手順の粒度が細かくなります
              </span>
              <input
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => pickFile(e.target.files?.[0])}
              />
            </label>
          </section>
        ) : (
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-6 py-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <svg
                  className="h-8 w-8 shrink-0 text-zinc-600"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <rect x="2" y="5" width="20" height="14" rx="2" />
                  <path d="m10 9.5 5 2.5-5 2.5z" fill="currentColor" stroke="none" />
                </svg>
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-medium text-zinc-100">{fileName}</h2>
                  <p className="mt-0.5 text-xs text-zinc-500">{statusLine}</p>
                </div>
              </div>

              <label className="shrink-0 cursor-pointer rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-800">
                別の動画を選ぶ
                <input
                  type="file"
                  accept="video/*"
                  className="hidden"
                  disabled={analyzing}
                  onChange={(e) => pickFile(e.target.files?.[0])}
                />
              </label>
            </div>

            {analyzing && frameCount > 0 && (
              <div className="mt-3 h-1 w-full overflow-hidden rounded bg-zinc-800">
                <div
                  className="h-full bg-emerald-500 transition-all duration-300"
                  style={{ width: `${(frames.length / frameCount) * 100}%` }}
                />
              </div>
            )}
          </section>
        )}

        {status === "error" && (
          <p className="rounded-lg bg-red-950/50 px-4 py-3 text-sm text-red-300">
            エラー: {error}
          </p>
        )}

        {status === "done" && utteranceCount === 0 && (
          <p className="rounded-lg bg-amber-950/40 px-4 py-3 text-sm text-amber-300">
            音声が検出されませんでした。WHISPER_MODEL の設定を確認してください。
            画面の見た目だけから手順を作るため、精度が大きく下がります。
          </p>
        )}

        {videoUrl && (
          <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="flex flex-col gap-6">
              {/* h-auto が無いと video の高さが既定の 150px のままになる */}
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                className="h-auto max-h-[70vh] w-full rounded-xl border border-zinc-800 bg-black object-contain"
              />

              <ManualSteps
                fileName={fileName}
                summary={summary}
                steps={steps}
                onSeek={seekTo}
                annotating={annotating}
                annotateProgress={annotateProgress}
                onReannotate={reannotate}
                verifying={verifying}
                verifyProgress={verifyProgress}
                onReverify={reverify}
              />

              {summary && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
                  <h2 className="mb-3 text-sm font-medium text-zinc-400">概要</h2>
                  <p className="text-sm leading-7 text-zinc-100">{summary}</p>
                </div>
              )}

              {utterances.length > 0 && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
                  <h2 className="mb-4 text-sm font-medium text-zinc-400">字幕</h2>
                  <ol className="flex max-h-80 flex-col gap-1 overflow-y-auto">
                    {utterances.map((u) => (
                      <li key={u.start}>
                        <button
                          type="button"
                          onClick={() => seekTo(u.start)}
                          className="flex w-full items-baseline gap-3 rounded p-2 text-left transition-colors hover:bg-zinc-800/70"
                        >
                          <span className="shrink-0 font-mono text-xs text-emerald-400">
                            {formatTime(u.start)}
                          </span>
                          <span className="text-sm text-zinc-200">{u.text}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>

            <aside className="flex flex-col gap-6">
              {steps.length > 0 && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
                  <h2 className="mb-3 text-sm font-medium text-zinc-400">目次</h2>
                  <ol className="flex flex-col gap-1">
                    {steps.map((step, index) => (
                      <li key={`${index}-${step.time}`}>
                        <button
                          type="button"
                          onClick={() => seekTo(step.time)}
                          className="flex w-full items-baseline gap-3 rounded p-2 text-left transition-colors hover:bg-zinc-800/70"
                        >
                          <span className="shrink-0 font-mono text-xs text-emerald-400">
                            {index + 1}
                          </span>
                          <span className="text-sm text-zinc-200">{step.title}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {status === "done" && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
                  <h2 className="mb-3 text-sm font-medium text-zinc-400">手順を検索</h2>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void search();
                    }}
                    className="flex gap-2"
                  >
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="例: 保存ボタン"
                      className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none placeholder:text-zinc-600 focus:border-zinc-500"
                    />
                    <button
                      type="submit"
                      disabled={searching}
                      className="rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white disabled:opacity-50"
                    >
                      {searching ? "…" : "検索"}
                    </button>
                  </form>

                  {hits && (
                    <ol className="mt-4 flex flex-col gap-2">
                      {hits.length === 0 && (
                        <li className="text-sm text-zinc-500">見つかりませんでした</li>
                      )}
                      {hits.map((hit) => (
                        <li key={hit.time}>
                          <button
                            type="button"
                            onClick={() => seekTo(hit.time)}
                            className="flex w-full flex-col gap-1 rounded p-2 text-left transition-colors hover:bg-zinc-800/70"
                          >
                            <span className="font-mono text-xs text-emerald-400">
                              {formatTime(hit.time)}
                              <span className="ml-2 text-zinc-500">
                                {(hit.score * 100).toFixed(0)}%
                              </span>
                            </span>
                            <span className="line-clamp-2 text-sm text-zinc-300">{hit.text}</span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}

              {status === "done" && <QaChat analysisId={analysisId} onSeek={seekTo} />}
            </aside>
          </section>
        )}
      </main>
    </div>
  );
}
