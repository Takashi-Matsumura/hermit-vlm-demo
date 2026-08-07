import { isAnalysisId, loadAnalysis, retrieve } from "@/lib/analysis";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const { id, query } = (await request.json()) as { id?: string; query?: string };

  if (!id || !query?.trim()) {
    return Response.json({ error: "id と query は必須です" }, { status: 400 });
  }
  if (!isAnalysisId(id)) {
    return Response.json({ error: "id の形式が不正です" }, { status: 400 });
  }

  const result = await loadAnalysis(id);
  if (!result) {
    return Response.json({ error: "解析結果が見つかりません" }, { status: 404 });
  }

  const hits = await retrieve(result, query, 5);
  if (!hits) {
    return Response.json({ error: "クエリのベクトル化に失敗しました" }, { status: 500 });
  }
  return Response.json({ hits });
}
