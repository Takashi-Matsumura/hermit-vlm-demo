import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { framePath, isAnalysisId } from "@/lib/analysis";
import { mapWithConcurrency } from "@/lib/concurrency";
import { verifyStepScreenshot } from "@/lib/llm";
import { extractFrame } from "@/lib/video";
import { parseVerification, selectCandidateTimes } from "@/lib/verification";
import type { ManualResult, ManualStepWithMeta, ManualVerifyEvent, StepVerification } from "@/lib/types";

// フレーム PNG の読み書き（ffmpeg 新規抽出を含む）と result.json の更新を行うので
// Node.js ランタイムで動かす
export const runtime = "nodejs";

const UPLOAD_ROOT = path.join(process.cwd(), "public", "uploads");
/** 「検出→修正→再検出」を最大この回数まで繰り返す */
const MAX_ROUNDS = 3;

/**
 * 検証サブエージェントの並列度。annotate（既定3）と違い、1手順あたり
 * 「現在の画像+新規候補3〜4枚」を同時にVLMへ送るので1リクエストが重い。
 * その分だけ既定を1段階下げてある。
 */
const CONCURRENCY = Number(process.env.MANUAL_VERIFY_CONCURRENCY ?? "2");

async function readPngBase64(p: string): Promise<string> {
  return (await readFile(p)).toString("base64");
}

/** フレーム PNG が無ければ ffmpeg で新規抽出してから読む（既にあれば抽出をスキップする） */
async function ensureFrame(videoPath: string, time: number, outPath: string): Promise<void> {
  try {
    await readFile(outPath);
  } catch {
    await extractFrame(videoPath, time, outPath);
  }
}

export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const id = body && typeof body === "object" ? (body as { id?: unknown }).id : undefined;

  if (!isAnalysisId(id)) {
    return Response.json({ error: "id が不正です" }, { status: 400 });
  }

  const dir = path.join(UPLOAD_ROOT, id);
  const resultPath = path.join(dir, "result.json");
  const videoPath = path.join(dir, "video.mp4");

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

  if (result.steps.length === 0) {
    return Response.json({ error: "手順がありません" }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ManualVerifyEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        // steps はループの中で書き換えていく。3周をこのエンドポイント内で完結させ、
        // 最後に1回だけ result.json に書き戻す（周回間の状態をHTTPリクエスト間で
        // 受け渡す必要をなくすため）
        const current: ManualStepWithMeta[] = [...result.steps];
        const existingFrameTimes = current.map((s) => s.time);
        const utteranceRanges = result.utterances.map((u) => ({ start: u.start, end: u.end }));

        let totalFixed = 0;
        let targetIndices = current.map((_, i) => i); // 1周目は全件

        for (let round = 1; round <= MAX_ROUNDS && targetIndices.length > 0; round++) {
          send({ type: "round-start", round, targets: targetIndices.length });
          const stillMismatched: number[] = [];

          await mapWithConcurrency(targetIndices, CONCURRENCY, async (index) => {
            const step = current[index];
            let matches = false;
            let replacedTime: number | undefined;
            let replacedImageUrl: string | undefined;

            try {
              const candidateTimes = selectCandidateTimes(
                step.time,
                utteranceRanges,
                existingFrameTimes,
                result.duration,
              );

              if (candidateTimes.length > 0) {
                const currentBase64 = await readPngBase64(framePath(id, step.time));
                const candidatePngs = await Promise.all(
                  candidateTimes.map(async (t) => {
                    const p = framePath(id, t);
                    await ensureFrame(videoPath, t, p);
                    return { time: t, base64: await readPngBase64(p) };
                  }),
                );

                const raw = await verifyStepScreenshot({
                  title: step.title,
                  description: step.description,
                  candidates: [{ time: step.time, base64: currentBase64 }, ...candidatePngs],
                });
                const parsed = parseVerification(raw, candidatePngs.length + 1);

                if (parsed.ok && parsed.best >= 2) {
                  // 候補に差し替える。画像が変わるので古い注釈（赤枠）は無効化する
                  const chosen = candidatePngs[parsed.best - 2];
                  replacedTime = chosen.time;
                  replacedImageUrl = `/uploads/${id}/frames/f_${chosen.time.toFixed(3)}.png`;
                  current[index] = {
                    ...step,
                    time: chosen.time,
                    imageUrl: replacedImageUrl,
                    annotation: undefined,
                  };
                  existingFrameTimes.push(chosen.time);
                  totalFixed++;
                  matches = true;
                } else {
                  // best===1（現状維持）/ best===0（一致なし）/ パース失敗は
                  // いずれも「今回は動かさない」。誤って画像を差し替えるより安全
                  matches = parsed.ok && parsed.best === 1;
                }
              }
              // candidateTimes が空（発話が無い等）なら判断材料が無いので matches=false のまま
            } catch (error) {
              console.error(`[verify] 検証に失敗しました（手順${index + 1} / ${step.time}秒）:`, error);
            }

            const isFinal = matches || round >= MAX_ROUNDS;
            const verification: StepVerification = {
              matches,
              needsReview: isFinal && !matches,
              resolvedAtRound: round,
            };
            if (isFinal) {
              current[index] = { ...current[index], verification };
            } else {
              stillMismatched.push(index);
            }

            send({
              type: "verification",
              round,
              index,
              time: current[index].time,
              replacedImageUrl,
              replacedTime,
              verification,
            });
          });

          send({ type: "round-done", round, fixed: totalFixed, remaining: stillMismatched.length });
          targetIndices = stillMismatched;
        }

        const needsReviewCount = current.filter((s) => s.verification?.needsReview).length;
        const updated: ManualResult = { ...result, steps: current };

        // result.json は解析に数分かけて作った既存ファイルの上書きになるので、
        // 書き込み途中でプロセスが落ちても壊れないよう一時ファイル経由でアトミックに置き換える
        const tmpPath = path.join(dir, `result.json.tmp-${randomUUID()}`);
        await writeFile(tmpPath, JSON.stringify(updated));
        await rename(tmpPath, resultPath);

        send({ type: "done", totalFixed, needsReview: needsReviewCount });
      } catch (error) {
        console.error("[verify] 検証処理に失敗しました:", error);
        send({
          type: "error",
          message: "検証処理に失敗しました。サーバのログを確認してください。",
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
