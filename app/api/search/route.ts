import { readFile } from "node:fs/promises";
import path from "node:path";

import { cosineSimilarity, embed } from "@/lib/llm";
import type { AnalysisResult, SearchHit } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const { id, query } = (await request.json()) as { id?: string; query?: string };

  if (!id || !query?.trim()) {
    return Response.json({ error: "id と query は必須です" }, { status: 400 });
  }
  // id は解析時に randomUUID() で発番したものだけを受け付ける（パストラバーサル対策）
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return Response.json({ error: "id の形式が不正です" }, { status: 400 });
  }

  const resultPath = path.join(process.cwd(), "public", "uploads", id, "result.json");

  let result: AnalysisResult;
  try {
    result = JSON.parse(await readFile(resultPath, "utf-8")) as AnalysisResult;
  } catch {
    return Response.json({ error: "解析結果が見つかりません" }, { status: 404 });
  }

  const [queryVector] = await embed([query]);
  if (!queryVector) {
    return Response.json({ error: "クエリのベクトル化に失敗しました" }, { status: 500 });
  }

  const hits: SearchHit[] = result.captions
    .map((c) => ({
      time: c.time,
      text: c.text,
      imageUrl: c.imageUrl,
      score: cosineSimilarity(queryVector, c.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return Response.json({ hits });
}
