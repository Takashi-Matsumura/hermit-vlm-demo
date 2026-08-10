"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";

import { formatTime } from "@/lib/manual";
import { readSse } from "@/lib/sse";
import type {
  ManualAnalyzeEvent,
  ManualAnnotateEvent,
  ManualIntent,
  ManualNarratedEvent,
  ManualStepWithMeta,
  ManualVerifyEvent,
  SearchHit,
  Utterance,
} from "@/lib/types";
import {
  deriveNarratedWorkflow,
  deriveWorkflow,
  IDLE_RUN,
  narratedPhaseRank,
  type AnalyzePhase,
  type NarratedPhase,
  type SubAgentRun,
} from "@/lib/workflow";

import ManualIntentView from "./ManualIntent";
import ManualSteps from "./ManualSteps";
import QaChat from "./QaChat";
import WorkflowHeader from "./WorkflowHeader";

type FrameItem = { time: number; text: string; imageUrl: string; fromUtterance: boolean };

type Status = "idle" | "analyzing" | "done" | "error";
/** edited = 完成動画から（既存）/ narrated = 実況収録から（意図駆動、新規） */
type Mode = "edited" | "narrated";

export default function ManualPage() {
  const [status, setStatus] = useState<Status>("idle");
  const [mode, setMode] = useState<Mode>("edited");
  const [fileName, setFileName] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [dragging, setDragging] = useState(false);

  const [analysisId, setAnalysisId] = useState<string>("");
  const [videoUrl, setVideoUrl] = useState<string>("");
  const [duration, setDuration] = useState<number>(0);
  const [frameCount, setFrameCount] = useState<number>(0);
  const [utteranceCount, setUtteranceCount] = useState<number>(0);
  const [utteranceFrameCount, setUtteranceFrameCount] = useState<number>(0);
  // analyze の SSE で最後に届いたイベント種別。ワークフロー表示のフェーズ判定に使う
  // （frames.length と frameCount の枚数比較は、抽出失敗フレームがあると壊れるため使わない）
  const [phase, setPhase] = useState<AnalyzePhase>("");

  // --- 実況収録モード（narrated）専用の状態。完成動画モードの状態とは混ぜない ---
  const [narratedPhase, setNarratedPhase] = useState<NarratedPhase>("");
  const [intent, setIntent] = useState<ManualIntent | null>(null);
  const [chunkCount, setChunkCount] = useState<number>(0);
  const [chunkDoneCount, setChunkDoneCount] = useState<number>(0);
  const [plannedCount, setPlannedCount] = useState<number>(0);
  const [captureTotal, setCaptureTotal] = useState<number>(0);
  const [captureDoneCount, setCaptureDoneCount] = useState<number>(0);
  const [narratedStepCount, setNarratedStepCount] = useState<number>(0);

  const [frames, setFrames] = useState<FrameItem[]>([]);
  const [summary, setSummary] = useState<string>("");
  const [steps, setSteps] = useState<ManualStepWithMeta[]>([]);
  const [utterances, setUtterances] = useState<Utterance[]>([]);

  const [query, setQuery] = useState<string>("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const [annotateRun, setAnnotateRun] = useState<SubAgentRun>(IDLE_RUN);
  const [verifyRun, setVerifyRun] = useState<SubAgentRun>(IDLE_RUN);
  // ManualSteps 等、既存の呼び出し側との互換のためのローカル派生値
  const annotating = annotateRun.state === "running";
  const verifying = verifyRun.state === "running";

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
   *
   * crop-and-zoom で最大3周ループする（verify と同じ設計）。周回ごとに
   * round-start/round-done が届き、その間の annotation イベントには「その時点での
   * 最良の注釈」が入っている（N周目が見つからなくても、前周の正しい枠を消さない）。
   */
  const annotate = useCallback(async (id: string) => {
    setAnnotateRun({ state: "running", round: 0, done: 0, total: 0 });

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
            setAnnotateRun((prev) => ({ ...prev, rounds: event.rounds }));
            break;
          case "round-start":
            setAnnotateRun((prev) => ({ ...prev, round: event.round, done: 0, total: event.targets }));
            break;
          case "annotation":
            setAnnotateRun((prev) => ({ ...prev, done: prev.done + 1 }));
            // index で突合する（time ではない）。手順統合に失敗したグループでは
            // 同じ time の手順が複数残りうるため
            setSteps((prev) =>
              prev.map((step, i) =>
                i === event.index ? { ...step, annotation: event.annotation ?? undefined } : step,
              ),
            );
            break;
          case "done":
            setAnnotateRun((prev) => ({ ...prev, state: "done", result: `注釈 ${event.annotated}件` }));
            break;
          case "error":
            setAnnotateRun((prev) => ({ ...prev, state: "failed" }));
            break;
          case "round-done":
            break;
        }
      });
    } catch (e) {
      console.error("[manual] 注釈の生成に失敗しました:", e);
    } finally {
      // done/error イベントで既に確定済みなら上書きしない。ストリームが完了扱いになった
      // のに running のままなら（例: 400/404 でイベントが1件も来なかった場合）失敗とみなす
      if (activeIdRef.current === id) {
        setAnnotateRun((prev) => (prev.state === "running" ? { ...prev, state: "failed" } : prev));
      }
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
      setVerifyRun({ state: "running", round: 0, done: 0, total: 0 });

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
              setVerifyRun((prev) => ({ ...prev, round: event.round, done: 0, total: event.targets }));
              break;
            case "verification":
              setVerifyRun((prev) => ({ ...prev, done: prev.done + 1 }));
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
            case "done":
              setVerifyRun((prev) => ({ ...prev, state: "done", result: `差し替え ${event.totalFixed}件` }));
              break;
            case "error":
              setVerifyRun((prev) => ({ ...prev, state: "failed" }));
              break;
            case "round-done":
              break;
          }
        });
      } catch (e) {
        console.error("[manual] スクリーンショットの検証に失敗しました:", e);
      } finally {
        if (activeIdRef.current === id) {
          setVerifyRun((prev) => (prev.state === "running" ? { ...prev, state: "failed" } : prev));
        }
      }

      // verify が失敗しても、まだ意味のあるスクリーンショットには注釈を付けたいので続行する
      void annotate(id);
    },
    [annotate],
  );

  /** 完成動画モード（既存）。中身は無改修。 */
  const analyzeEdited = useCallback(async (file: File) => {
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
    setPhase("");
    // 前の動画のサブエージェントがまだ走っていても、その結果は新しい動画に適用しない
    activeIdRef.current = "";
    setVerifyRun(IDLE_RUN);
    setAnnotateRun(IDLE_RUN);

    const formData = new FormData();
    formData.append("video", file);

    try {
      const res = await fetch("/api/manual/analyze", { method: "POST", body: formData });
      if (!res.body) throw new Error("レスポンスが空です");

      await readSse<ManualAnalyzeEvent>(res.body, (event) => {
        // ワークフロー表示のフェーズ判定用。error は含めない（失敗直前の到達点を保持するため）
        if (event.type !== "error") setPhase(event.type);

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

  /**
   * 実況収録モード（意図駆動）。/api/manual/narrated/analyze の SSE を読む。
   *
   * chunk・capture・step は mapWithConcurrency による並列実行で完了順に届くため、
   * narratedPhase の更新は last-wins ではなく narratedPhaseRank による最大値更新にする
   * （でなければ後から届いた低ランクのイベントでワークフロー表示のフェーズが逆行する）。
   *
   * steps は result.json の最終配列と添字を一致させる必要がある（verify/annotate が
   * index で突合するため）。narrated モードは手順ごとに並列で確定し、まれに1手順が
   * まるごと省略されることがある（route.ts 参照）ので、受信順にそのまま積むのではなく
   * event.index（= 計画項目の添字）でスパース配列に積み、done の時点で
   * まとめて詰める。これはサーバの finalSteps = steps.filter(Boolean) と同じ操作なので、
   * 同じ添字の並びになることが保証される。
   */
  const analyzeNarrated = useCallback(async (file: File) => {
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
    setNarratedPhase("");
    setIntent(null);
    setChunkCount(0);
    setChunkDoneCount(0);
    setPlannedCount(0);
    setCaptureTotal(0);
    setCaptureDoneCount(0);
    setNarratedStepCount(0);
    activeIdRef.current = "";
    setVerifyRun(IDLE_RUN);
    setAnnotateRun(IDLE_RUN);

    const formData = new FormData();
    formData.append("video", file);

    const collectedSteps: (ManualStepWithMeta | undefined)[] = [];

    try {
      const res = await fetch("/api/manual/narrated/analyze", { method: "POST", body: formData });
      if (!res.body) throw new Error("レスポンスが空です");

      await readSse<ManualNarratedEvent>(res.body, (event) => {
        if (event.type !== "error") {
          setNarratedPhase((prev) => (narratedPhaseRank(event.type) > narratedPhaseRank(prev) ? event.type : prev));
        }

        switch (event.type) {
          case "info":
            activeIdRef.current = event.id;
            setAnalysisId(event.id);
            setVideoUrl(event.videoUrl);
            setDuration(event.duration);
            setUtteranceCount(event.utteranceCount);
            setChunkCount(event.chunkCount);
            break;
          case "utterances":
            setUtterances(event.utterances);
            break;
          case "chunk":
            setChunkDoneCount((prev) => prev + 1);
            break;
          case "intent":
            setIntent(event.intent);
            break;
          case "plan":
            setPlannedCount(event.planned.length);
            break;
          case "capture":
            setCaptureTotal(event.total);
            setCaptureDoneCount((prev) => prev + 1);
            break;
          case "step":
            collectedSteps[event.index] = event.step;
            setNarratedStepCount((prev) => prev + 1);
            break;
          case "summary":
            setSummary(event.text);
            break;
          case "done":
            setSteps(collectedSteps.filter((s): s is ManualStepWithMeta => s !== undefined));
            setStatus("done");
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

  const analyze = useCallback(
    (file: File) => {
      if (mode === "edited") void analyzeEdited(file);
      else void analyzeNarrated(file);
    },
    [mode, analyzeEdited, analyzeNarrated],
  );

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

  // 動的なフェーズ文言はワークフロー表示（WorkflowHeader）に任せ、ここは確定した
  // メタ情報だけを出す（analyzing 中は info 到着まで空文字のまま）。
  // frameCount/plannedCount はモード固有の概念なので、他方のモードの残留値を見せない。
  const metaLine = [
    duration > 0 && `${duration.toFixed(1)}秒`,
    mode === "edited" && frameCount > 0 && `${frameCount}フレーム（うち発話区切れ ${utteranceFrameCount}）`,
    mode === "narrated" && plannedCount > 0 && `${plannedCount}項目`,
    utteranceCount > 0 && `発話 ${utteranceCount}件`,
  ]
    .filter(Boolean)
    .join(" · ");

  const workflowSteps =
    mode === "edited"
      ? deriveWorkflow({
          status,
          phase,
          frameCount,
          captionedCount: frames.length,
          utteranceCount,
          stepCount: steps.length,
          verify: verifyRun,
          annotate: annotateRun,
        })
      : deriveNarratedWorkflow({
          status,
          phase: narratedPhase,
          utteranceCount,
          chunkCount,
          chunkDoneCount,
          plannedCount,
          captureTotal,
          captureDoneCount,
          stepCount: narratedStepCount,
          verify: verifyRun,
          annotate: annotateRun,
        });

  const workflowProgress = (() => {
    if (mode === "edited") {
      const captionStep = workflowSteps.find((s) => s.id === "caption");
      return captionStep?.status === "running" && frameCount > 0
        ? { done: frames.length, total: frameCount }
        : null;
    }
    const captureStep = workflowSteps.find((s) => s.id === "capture");
    return captureStep?.status === "running" && captureTotal > 0
      ? { done: captureDoneCount, total: captureTotal }
      : null;
  })();

  return (
    <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900">
      <main className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-12">
        <header className="flex flex-col gap-2">
          <Link
            href="/"
            className="w-fit text-xs text-zinc-500 underline decoration-dotted hover:text-zinc-700"
          >
            ← 動画言語化デモ
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight">操作マニュアル自動生成</h1>
          <p className="text-sm text-zinc-600">
            操作画面の録画とナレーションから手順書を作ります。
          </p>
        </header>

        {status === "idle" ? (
          <section className="rounded-xl border border-zinc-200 bg-white p-6">
            <div className="mb-4 flex gap-2" role="tablist" aria-label="入力モード">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "edited"}
                onClick={() => setMode("edited")}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  mode === "edited"
                    ? "bg-zinc-900 text-zinc-100"
                    : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
                }`}
              >
                完成動画から
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "narrated"}
                onClick={() => setMode("narrated")}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  mode === "narrated"
                    ? "bg-zinc-900 text-zinc-100"
                    : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
                }`}
              >
                実況収録から
              </button>
            </div>

            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              className={`flex cursor-pointer flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-14 transition-colors ${
                dragging
                  ? "border-emerald-500 bg-emerald-50"
                  : "border-zinc-300 hover:border-zinc-500 hover:bg-zinc-100"
              }`}
            >
              <svg
                className={`h-10 w-10 transition-colors ${dragging ? "text-emerald-600" : "text-zinc-400"}`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <rect x="2" y="5" width="20" height="14" rx="2" />
                <path d="m10 9.5 5 2.5-5 2.5z" fill="currentColor" stroke="none" />
              </svg>
              <span className="text-sm text-zinc-700">
                {dragging
                  ? "ここにドロップ"
                  : mode === "edited"
                    ? "操作を声で説明しながら録画した画面録画をドロップ"
                    : "アプリを操作しながら実況したナレーション動画をドロップ"}
              </span>
              <span className="text-xs text-zinc-500">
                {mode === "edited"
                  ? "発話の区切れ目でも画面を切り出すので、手順の粒度が細かくなります"
                  : "実況しながら収録した動画から、作成者の意図を汲んで手順書を作ります（文字起こし必須）"}
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
          <section className="rounded-xl border border-zinc-200 bg-white px-6 py-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <svg
                  className="h-8 w-8 shrink-0 text-zinc-400"
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
                  <h2 className="truncate text-sm font-medium text-zinc-900">{fileName}</h2>
                  {metaLine && <p className="mt-0.5 text-xs text-zinc-500">{metaLine}</p>}
                </div>
              </div>

              <label className="shrink-0 cursor-pointer rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 transition-colors hover:border-zinc-500 hover:bg-zinc-200">
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

            <WorkflowHeader steps={workflowSteps} progress={workflowProgress} />
          </section>
        )}

        {status === "error" && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            エラー: {error}
          </p>
        )}

        {status === "done" && utteranceCount === 0 && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
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
                className="h-auto max-h-[70vh] w-full rounded-xl border border-zinc-200 bg-black object-contain"
              />

              {mode === "narrated" && intent && <ManualIntentView intent={intent} />}

              <ManualSteps
                fileName={fileName}
                summary={summary}
                steps={steps}
                intent={mode === "narrated" ? intent : undefined}
                onSeek={seekTo}
                annotating={annotating}
                onReannotate={reannotate}
                verifying={verifying}
                onReverify={reverify}
              />

              {summary && (
                <div className="rounded-xl border border-zinc-200 bg-white p-6">
                  <h2 className="mb-3 text-sm font-medium text-zinc-600">概要</h2>
                  <p className="text-sm leading-7 text-zinc-900">{summary}</p>
                </div>
              )}

              {utterances.length > 0 && (
                <div className="rounded-xl border border-zinc-200 bg-white p-6">
                  <h2 className="mb-4 text-sm font-medium text-zinc-600">字幕</h2>
                  <ol className="flex max-h-80 flex-col gap-1 overflow-y-auto">
                    {utterances.map((u) => (
                      <li key={u.start}>
                        <button
                          type="button"
                          onClick={() => seekTo(u.start)}
                          className="flex w-full items-baseline gap-3 rounded p-2 text-left transition-colors hover:bg-zinc-200/70"
                        >
                          <span className="shrink-0 font-mono text-xs text-emerald-600">
                            {formatTime(u.start)}
                          </span>
                          <span className="text-sm text-zinc-800">{u.text}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>

            <aside className="flex flex-col gap-6">
              {steps.length > 0 && (
                <div className="rounded-xl border border-zinc-200 bg-white p-5">
                  <h2 className="mb-3 text-sm font-medium text-zinc-600">目次</h2>
                  <ol className="flex flex-col gap-1">
                    {steps.map((step, index) => (
                      <li key={`${index}-${step.time}`}>
                        <button
                          type="button"
                          onClick={() => seekTo(step.time)}
                          className="flex w-full items-baseline gap-3 rounded p-2 text-left transition-colors hover:bg-zinc-200/70"
                        >
                          <span className="shrink-0 font-mono text-xs text-emerald-600">
                            {index + 1}
                          </span>
                          <span className="text-sm text-zinc-800">{step.title}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {status === "done" && (
                <div className="rounded-xl border border-zinc-200 bg-white p-5">
                  <h2 className="mb-3 text-sm font-medium text-zinc-600">手順を検索</h2>
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
                      className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm outline-none placeholder:text-zinc-400 focus:border-zinc-500"
                    />
                    <button
                      type="submit"
                      disabled={searching}
                      className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-100 transition-colors hover:bg-zinc-800 disabled:opacity-50"
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
                            className="flex w-full flex-col gap-1 rounded p-2 text-left transition-colors hover:bg-zinc-200/70"
                          >
                            <span className="font-mono text-xs text-emerald-600">
                              {formatTime(hit.time)}
                              <span className="ml-2 text-zinc-500">
                                {(hit.score * 100).toFixed(0)}%
                              </span>
                            </span>
                            <span className="line-clamp-2 text-sm text-zinc-700">{hit.text}</span>
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
