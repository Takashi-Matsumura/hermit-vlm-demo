/**
 * 解析済みの動画（result.json）まわりの共通処理。
 * /api/search と /api/ask の両方から使う。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { cosineSimilarity, embed } from "@/lib/llm";
import type { AnalysisResult, SearchHit } from "@/lib/types";

const UPLOAD_ROOT = path.join(process.cwd(), "public", "uploads");

/** id は解析時に randomUUID() で発番したものだけを受け付ける（パストラバーサル対策） */
export function isAnalysisId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id);
}

export async function loadAnalysis(id: string): Promise<AnalysisResult | null> {
  const resultPath = path.join(UPLOAD_ROOT, id, "result.json");
  try {
    return JSON.parse(await readFile(resultPath, "utf-8")) as AnalysisResult;
  } catch {
    return null;
  }
}

/**
 * クエリに近いキャプション・発話を上位 topK 件、コサイン類似度の降順で返す。
 * 発話ヒットは text に「（発話）」を付け、映像由来と区別できるようにする
 * （/api/ask の answerFromCaptions にそのまま渡っても、gemma がテキストだけで
 * 答えられる根拠として発話内容を認識できる）。
 * ベクトル化に失敗したら null。
 */
export async function retrieve(
  result: AnalysisResult,
  query: string,
  topK: number,
): Promise<SearchHit[] | null> {
  const [queryVector] = await embed([query]);
  if (!queryVector) return null;

  const captionHits: SearchHit[] = result.captions.map((c) => ({
    time: c.time,
    text: c.text,
    imageUrl: c.imageUrl,
    score: cosineSimilarity(queryVector, c.embedding),
  }));
  const utteranceHits: SearchHit[] = (result.utterances ?? []).map((u) => ({
    time: u.start,
    text: `（発話）${u.text}`,
    score: cosineSimilarity(queryVector, u.embedding),
  }));

  return [...captionHits, ...utteranceHits]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/** フレーム PNG の実パス。imageUrl（クライアント入力由来）ではなく time から組み立てる */
export function framePath(id: string, time: number): string {
  return path.join(UPLOAD_ROOT, id, "frames", `f_${time.toFixed(3)}.png`);
}
