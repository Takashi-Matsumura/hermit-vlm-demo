"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { AskCitation, AskResponse, AskSource, ChatTurn } from "@/lib/types";
import { formatTime } from "@/lib/manual";

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

/**
 * 手順に質問するチャット。app/page.tsx の同機能と同じ /api/ask をそのまま叩く
 * （ManualResult は AnalysisResult のスーパーセットなので API 側は無変更で動く）。
 * 既存ページは変更しない方針のため、実装はここに複製してある。
 */
export default function QaChat({
  analysisId,
  onSeek,
}: {
  analysisId: string;
  onSeek: (time: number) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState<string>("");
  const [asking, setAsking] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="mb-3 text-sm font-medium text-zinc-400">手順に質問する</h2>

      {messages.length > 0 && (
        <div className="mb-4 flex max-h-96 flex-col gap-3 overflow-y-auto">
          {messages.map((m) => (
            <div key={m.id} className={`max-w-full ${m.role === "user" ? "self-end" : "self-start"}`}>
              {m.role === "user" ? (
                <p className="rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100">{m.content}</p>
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
                          onClick={() => onSeek(c.time)}
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
          placeholder="例: 手順3で入力した値は？"
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
  );
}
