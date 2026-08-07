import { readFile } from "node:fs/promises";

import { framePath, isAnalysisId, loadAnalysis, retrieve } from "@/lib/analysis";
import {
  answerFromCaptions,
  answerFromFrames,
  needsImageEscalation,
} from "@/lib/llm";
import type { AskResponse, ChatTurn } from "@/lib/types";

export const runtime = "nodejs";

/** VLM にエスカレーションするとき見直すフレーム数 */
const ASK_VLM_FRAMES = Number(process.env.ASK_VLM_FRAMES ?? "2");

const MAX_QUESTION_LENGTH = 400;

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as {
    id?: string;
    question?: string;
    history?: ChatTurn[];
    forceVlm?: boolean;
  };
  const { id, question, forceVlm } = body;
  const history = Array.isArray(body.history) ? body.history : [];

  if (!id || !question?.trim()) {
    return Response.json({ error: "id と question は必須です" }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return Response.json(
      { error: `question は ${MAX_QUESTION_LENGTH}文字以内にしてください` },
      { status: 400 },
    );
  }
  if (!isAnalysisId(id)) {
    return Response.json({ error: "id の形式が不正です" }, { status: 400 });
  }

  const result = await loadAnalysis(id);
  if (!result) {
    return Response.json({ error: "解析結果が見つかりません" }, { status: 404 });
  }

  try {
    // 単体では検索クエリとして弱い追加質問（「服の色は？」等）を補うため、
    // 直前の質問と連結してベクトル検索する。回答生成に渡すのは今回の質問のみ。
    const lastQuestion = [...history].reverse().find((h) => h.role === "user")?.content ?? "";
    const searchQuery = lastQuestion ? `${lastQuestion} ${question}` : question;

    const hits = await retrieve(result, searchQuery, 5);
    if (!hits) {
      return Response.json({ error: "質問のベクトル化に失敗しました" }, { status: 500 });
    }

    if (!forceVlm) {
      const answer = await answerFromCaptions(question, hits, history);
      if (!needsImageEscalation(answer)) {
        const response: AskResponse = {
          answer,
          source: "llm",
          citations: hits.slice(0, 3).map((h) => ({ time: h.time, text: h.text })),
        };
        return Response.json(response);
      }
    }

    // テキストだけでは答えられない（または画像での見直しを明示要求された）ので、
    // 上位フレームの画像を Qwen3-VL に見せ直す
    const escalationHits = hits.slice(0, ASK_VLM_FRAMES);
    const frames = await Promise.all(
      escalationHits.map(async (h) => ({
        time: h.time,
        base64: (await readFile(framePath(id, h.time))).toString("base64"),
      })),
    );

    const answer = await answerFromFrames(question, frames, history);
    const response: AskResponse = {
      answer,
      source: "vlm",
      citations: escalationHits.map((h) => ({ time: h.time, text: h.text })),
    };
    return Response.json(response);
  } catch (error) {
    // エンドポイントやローカルの絶対パスが例外メッセージに載るため、
    // 詳細はサーバログにだけ出してクライアントには汎用メッセージを返す
    console.error("[ask] 回答の生成に失敗しました:", error);
    return Response.json(
      { error: "回答の生成に失敗しました。サーバのログを確認してください。" },
      { status: 500 },
    );
  }
}
