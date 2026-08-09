import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { parseStepAnnotation, readPngSize } from "@/lib/annotation";
import { framePath, isAnalysisId } from "@/lib/analysis";
import { mapWithConcurrency } from "@/lib/concurrency";
import { annotateStepTarget } from "@/lib/llm";
import type { ManualAnnotateEvent, ManualResult, StepAnnotation } from "@/lib/types";

// フレーム PNG の読み書きと result.json の更新を行うので Node.js ランタイムで動かす
export const runtime = "nodejs";

const UPLOAD_ROOT = path.join(process.cwd(), "public", "uploads");

/**
 * 注釈サブエージェントの並列度。8084(VLM) は4スロットだが、4並列にすると
 * 同じ画面で QaChat（/api/ask）を使うユーザーが待たされるので、1スロットは空けておく。
 * 20手順・3並列で実測40〜60秒（直列なら140秒）。差の12秒より対話性を優先する。
 */
const CONCURRENCY = Number(process.env.MANUAL_ANNOTATE_CONCURRENCY ?? "3");

export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const id = body && typeof body === "object" ? (body as { id?: unknown }).id : undefined;

  if (!isAnalysisId(id)) {
    return Response.json({ error: "id が不正です" }, { status: 400 });
  }

  const dir = path.join(UPLOAD_ROOT, id);
  const resultPath = path.join(dir, "result.json");

  let result: ManualResult;
  try {
    const raw = JSON.parse(await readFile(resultPath, "utf-8")) as ManualResult;
    if (!Array.isArray(raw.steps)) {
      // /（トップページ）側の解析結果には steps が無い
      return Response.json({ error: "この動画には操作手順がありません" }, { status: 400 });
    }
    result = raw;
  } catch {
    return Response.json({ error: "指定された動画が見つかりません" }, { status: 404 });
  }

  const { steps } = result;
  if (steps.length === 0) {
    return Response.json({ error: "手順がありません" }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ManualAnnotateEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        send({ type: "start", total: steps.length });

        const annotations: (StepAnnotation | null)[] = new Array(steps.length).fill(null);
        let annotatedCount = 0;

        await mapWithConcurrency(steps, CONCURRENCY, async (step, index) => {
          try {
            const png = await readFile(framePath(id, step.time));
            const size = readPngSize(png);
            if (!size) {
              send({ type: "annotation", index, time: step.time, annotation: null, reason: "failed" });
              return;
            }

            // captions[].time と step.time はどちらも toFixed(3) 由来なので厳密一致で引ける
            const caption = result.captions.find((c) => c.time === step.time)?.text;

            const raw = await annotateStepTarget({
              pngBase64: png.toString("base64"),
              title: step.title,
              description: step.description,
              caption,
            });

            const parsed = parseStepAnnotation(raw, size);
            if (!parsed.ok) {
              // 棄却が「モデルが悪い」のか「閾値が厳しすぎる」のか判別できるよう、生の応答も残す
              console.warn(
                `[annotate] 注釈を採用しませんでした（手順${index + 1} / ${step.time}秒 / ${parsed.reason}）: ${raw.slice(0, 200)}`,
              );
              send({ type: "annotation", index, time: step.time, annotation: null, reason: parsed.reason });
              return;
            }

            annotations[index] = parsed.annotation;
            annotatedCount++;
            send({ type: "annotation", index, time: step.time, annotation: parsed.annotation });
          } catch (error) {
            // 1手順の失敗で全体を止めない（既存 /api/manual/analyze のフレームループと同じ方針）
            console.error(`[annotate] 注釈の生成に失敗しました（${step.time}秒）:`, error);
            send({ type: "annotation", index, time: step.time, annotation: null, reason: "failed" });
          }
        });

        const annotatedSteps = steps.map((step, index) => {
          const annotation = annotations[index];
          return annotation ? { ...step, annotation } : step;
        });
        const updated: ManualResult = { ...result, steps: annotatedSteps };

        // result.json は解析に数分かけて作った既存ファイルの上書きになるので、
        // 書き込み途中でプロセスが落ちても壊れないよう一時ファイル経由でアトミックに置き換える
        const tmpPath = path.join(dir, `result.json.tmp-${randomUUID()}`);
        await writeFile(tmpPath, JSON.stringify(updated));
        await rename(tmpPath, resultPath);

        send({ type: "done", annotated: annotatedCount });
      } catch (error) {
        console.error("[annotate] 注釈処理に失敗しました:", error);
        send({
          type: "error",
          message: "注釈の生成に失敗しました。サーバのログを確認してください。",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
