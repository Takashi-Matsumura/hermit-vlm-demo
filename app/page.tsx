"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";

import type {
  AnalyzeEvent,
  AskCitation,
  AskResponse,
  AskSource,
  Chapter,
  ChatTurn,
  FrameMethod,
  SearchHit,
} from "@/lib/types";

type TimelineItem = { time: number; text: string; imageUrl: string };

type Status = "idle" | "analyzing" | "done" | "error";

type ChatMessage =
  | { id: string; role: "user"; content: string }
  | {
      id: string;
      role: "assistant";
      content: string;
      source: AskSource;
      citations: AskCitation[];
      /** 「画像で見直す」から forceVlm 付きで再送するために元の質問を保持する */
      question: string;
    };

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [fileName, setFileName] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [dragging, setDragging] = useState(false);

  const [analysisId, setAnalysisId] = useState<string>("");
  const [videoUrl, setVideoUrl] = useState<string>("");
  const [duration, setDuration] = useState<number>(0);
  const [frameCount, setFrameCount] = useState<number>(0);
  const [method, setMethod] = useState<FrameMethod | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [summary, setSummary] = useState<string>("");
  const [chapters, setChapters] = useState<Chapter[]>([]);

  const [query, setQuery] = useState<string>("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState<string>("");
  const [asking, setAsking] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const seekTo = useCallback((time: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = time;
    void video.play();
  }, []);

  const analyze = useCallback(async (file: File) => {
    setStatus("analyzing");
    setFileName(file.name);
    setError("");
    setTimeline([]);
    setSummary("");
    setChapters([]);
    setHits(null);
    setFrameCount(0);
    setDuration(0);
    setMethod(null);
    setMessages([]);

    const formData = new FormData();
    formData.append("video", file);

    try {
      const res = await fetch("/api/analyze", { method: "POST", body: formData });
      if (!res.body) throw new Error("レスポンスが空です");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        // SSE は空行1つでイベント区切り
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";

        for (const chunk of chunks) {
          const line = chunk.trim();
          if (!line.startsWith("data:")) continue;

          const event = JSON.parse(line.slice(5).trim()) as AnalyzeEvent;

          switch (event.type) {
            case "info":
              setAnalysisId(event.id);
              setVideoUrl(event.videoUrl);
              setDuration(event.duration);
              setFrameCount(event.frameCount);
              setMethod(event.method);
              break;
            case "caption":
              setTimeline((prev) => [
                ...prev,
                { time: event.time, text: event.text, imageUrl: event.imageUrl },
              ]);
              break;
            case "summary":
              setSummary(event.text);
              break;
            case "chapters":
              setChapters(event.chapters);
              break;
            case "done":
              setStatus("done");
              break;
            case "error":
              setError(event.message);
              setStatus("error");
              break;
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, []);

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

  const ask = useCallback(
    async (questionText: string, forceVlm = false) => {
      if (!analysisId || !questionText.trim()) return;

      setAsking(true);
      const history: ChatTurn[] = messages.map((m) => ({ role: m.role, content: m.content }));
      if (!forceVlm) {
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: "user", content: questionText },
        ]);
      }

      try {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: analysisId, question: questionText, history, forceVlm }),
        });
        const data = (await res.json()) as Partial<AskResponse> & { error?: string };

        const reply: ChatMessage =
          res.ok && data.answer
            ? {
                id: crypto.randomUUID(),
                role: "assistant",
                content: data.answer,
                source: data.source ?? "llm",
                citations: data.citations ?? [],
                question: questionText,
              }
            : {
                id: crypto.randomUUID(),
                role: "assistant",
                content: data.error ?? "回答の生成に失敗しました。",
                source: "llm",
                citations: [],
                question: questionText,
              };
        setMessages((prev) => [...prev, reply]);
      } catch (e) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: e instanceof Error ? e.message : String(e),
            source: "llm",
            citations: [],
            question: questionText,
          },
        ]);
      } finally {
        setAsking(false);
      }
    },
    [analysisId, messages],
  );

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

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
    ? frameCount > 0
      ? `解析中… ${timeline.length} / ${frameCount} フレーム`
      : "シーンを検出しています…"
    : status === "error"
      ? "解析に失敗しました"
      : [
          duration > 0 && `${duration.toFixed(1)}秒`,
          frameCount > 0 &&
            (method === "interval" ? `${frameCount}フレーム（等間隔）` : `${frameCount}シーン`),
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <div className="min-h-screen bg-zinc-950 font-sans text-zinc-100">
      <main className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-12">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">動画言語化デモ</h1>
          <p className="text-sm text-zinc-400">
            ローカルの Qwen3-VL-8B が動画のシーンを日本語で説明し、gemma-4-12b が全体を要約します。
          </p>
        </header>

        {/* 未選択のときだけ大きなドロップゾーンを出し、選択後はタイトル表示に畳む */}
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
                  : "動画をドラッグ&ドロップ、またはクリックして選択"}
              </span>
              <span className="text-xs text-zinc-500">
                シーンが切り替わる瞬間だけを自動で抜き出して解析します
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
                  style={{ width: `${(timeline.length / frameCount) * 100}%` }}
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

        {videoUrl && (
          <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="flex flex-col gap-6">
              {/* プレイヤー */}
              {/* h-auto が無いと video の高さが既定の 150px のままになる */}
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                className="h-auto max-h-[70vh] w-full rounded-xl border border-zinc-800 bg-black object-contain"
              />

              {/* 質問応答 */}
              {status === "done" && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
                  <h2 className="mb-3 text-sm font-medium text-zinc-400">動画に質問する</h2>

                  {messages.length > 0 && (
                    <div className="mb-4 flex max-h-96 flex-col gap-3 overflow-y-auto">
                      {messages.map((m) => (
                        <div
                          key={m.id}
                          className={`max-w-[85%] ${m.role === "user" ? "self-end" : "self-start"}`}
                        >
                          {m.role === "user" ? (
                            <p className="rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100">
                              {m.content}
                            </p>
                          ) : (
                            <div className="flex flex-col gap-2 rounded-lg bg-zinc-950 px-3 py-2">
                              <span className="w-fit rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400">
                                {m.source === "vlm" ? "Qwen3-VL（画像）" : "gemma-4-12b（テキスト）"}
                              </span>
                              <p className="text-sm leading-6 text-zinc-200">{m.content}</p>
                              {m.citations.length > 0 && (
                                <div className="flex flex-wrap gap-3">
                                  {m.citations.map((c) => (
                                    <button
                                      key={c.time}
                                      type="button"
                                      onClick={() => seekTo(c.time)}
                                      className="font-mono text-xs text-emerald-400 hover:underline"
                                    >
                                      {formatTime(c.time)}
                                    </button>
                                  ))}
                                </div>
                              )}
                              {m.source === "llm" && (
                                <button
                                  type="button"
                                  onClick={() => void ask(m.question, true)}
                                  disabled={asking}
                                  className="w-fit text-xs text-zinc-500 underline decoration-dotted hover:text-zinc-300 disabled:opacity-50"
                                >
                                  画像で見直す
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                      <div ref={chatEndRef} />
                    </div>
                  )}

                  {asking && <p className="mb-3 text-xs text-zinc-500">回答を生成しています…</p>}

                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!question.trim()) return;
                      void ask(question);
                      setQuestion("");
                    }}
                    className="flex gap-2"
                  >
                    <input
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      placeholder="例: この子は何をしている？"
                      disabled={asking}
                      className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none placeholder:text-zinc-600 focus:border-zinc-500 disabled:opacity-50"
                    />
                    <button
                      type="submit"
                      disabled={asking}
                      className="rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white disabled:opacity-50"
                    >
                      {asking ? "…" : "質問する"}
                    </button>
                  </form>
                </div>
              )}

              {/* 全体要約 */}
              {summary && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
                  <h2 className="mb-3 text-sm font-medium text-zinc-400">全体要約</h2>
                  <p className="text-sm leading-7 text-zinc-100">{summary}</p>
                </div>
              )}

              {/* タイムライン */}
              {timeline.length > 0 && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
                  <h2 className="mb-4 text-sm font-medium text-zinc-400">タイムライン</h2>
                  <ol className="flex flex-col gap-4">
                    {timeline.map((item) => (
                      <li key={item.time}>
                        <button
                          type="button"
                          onClick={() => seekTo(item.time)}
                          className="flex w-full gap-4 rounded-lg p-2 text-left transition-colors hover:bg-zinc-800/70"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={item.imageUrl}
                            alt=""
                            className="h-16 w-16 shrink-0 rounded object-cover"
                          />
                          <div className="flex flex-col gap-1">
                            <span className="font-mono text-xs text-emerald-400">
                              {formatTime(item.time)}
                            </span>
                            <span className="text-sm leading-6 text-zinc-200">{item.text}</span>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>

            {/* サイドバー: 章 + 検索 */}
            <aside className="flex flex-col gap-6">
              {chapters.length > 0 && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
                  <h2 className="mb-3 text-sm font-medium text-zinc-400">シーン</h2>
                  <ol className="flex flex-col gap-1">
                    {chapters.map((chapter) => (
                      <li key={chapter.start}>
                        <button
                          type="button"
                          onClick={() => seekTo(chapter.start)}
                          className="flex w-full items-baseline gap-3 rounded p-2 text-left transition-colors hover:bg-zinc-800/70"
                        >
                          <span className="shrink-0 font-mono text-xs text-emerald-400">
                            {formatTime(chapter.start)}
                          </span>
                          <span className="text-sm text-zinc-200">{chapter.title}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {status === "done" && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
                  <h2 className="mb-3 text-sm font-medium text-zinc-400">シーン検索</h2>
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
                      placeholder="例: 売上のグラフ"
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
            </aside>
          </section>
        )}
      </main>
    </div>
  );
}
