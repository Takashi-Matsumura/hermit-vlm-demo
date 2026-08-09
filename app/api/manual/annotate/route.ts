import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  contentViewportFromCropDetect,
  FULL_VIEWPORT,
  hasConverged,
  isFullViewport,
  isPlausibleRefinement,
  parseStepAnnotation,
  pixelRectToViewport,
  readPngSize,
  viewportToPixelRect,
  zoomViewport,
} from "@/lib/annotation";
import { framePath, isAnalysisId } from "@/lib/analysis";
import { mapWithConcurrency } from "@/lib/concurrency";
import { annotateStepTarget, refineStepTarget } from "@/lib/llm";
import { cropFramePng, detectContentRect, getVideoInfo } from "@/lib/video";
import type {
  AnnotationTarget,
  ManualAnnotateEvent,
  ManualResult,
  ManualStepWithMeta,
  NormalizedBox,
} from "@/lib/types";

// フレーム PNG の読み書き（ffmpeg での crop/黒帯検出を含む）と result.json の更新を
// 行うので Node.js ランタイムで動かす
export const runtime = "nodejs";

const UPLOAD_ROOT = path.join(process.cwd(), "public", "uploads");

/**
 * 注釈サブエージェントの並列度。8084(VLM) は4スロットだが、4並列にすると
 * 同じ画面で QaChat（/api/ask）を使うユーザーが待たされるので、1スロットは空けておく。
 */
const CONCURRENCY = Number(process.env.MANUAL_ANNOTATE_CONCURRENCY ?? "3");
/**
 * crop-and-zoom の最大周回数。1 にすると従来の「1手順1回の呼び出しで確定」に戻る。
 * 3周目を「さらに拡大」ではなく「同倍率で中心を取り直す確認パス」にしても、その効果自体は
 * 実データでの A/B 比較（=2 と =3 の比較）で検証してから最終的な既定値を決める運用にしている。
 */
const MAX_ROUNDS = Number(process.env.MANUAL_ANNOTATE_ROUNDS ?? "3");
/** 0 でレターボックス（黒帯）除去を無効化する（A/B 計測用の逃げ道） */
const DELETTERBOX = process.env.MANUAL_ANNOTATE_DELETTERBOX !== "0";
/** VLM に渡す crop 画像の目標幅。トークン数と処理時間に直結する */
const CROP_WIDTH = Number(process.env.MANUAL_ANNOTATE_CROP_WIDTH ?? "1024");
/** crop 画像に占める面積比の上限（2周目以降）。「切り出し領域全体」を返す退化を弾く */
const MAX_LOCAL_AREA_RATIO = 0.5;

/** {手順の添字, その手順内での target の添字} で1つの crop-and-zoom ジョブを表す */
type RefineJob = { stepIndex: number; targetIndex: number };

/** ffmpeg の scale フィルタとの相性のため偶数に丸める。拡大はしても縮小はしない */
function targetCropWidth(rectWidth: number, cropWidth: number): number {
  const raw = Math.min(cropWidth, rectWidth * 3);
  const rounded = Math.round(raw / 2) * 2;
  return Math.max(rounded, rectWidth);
}

/**
 * VLM に見せる画像を用意する。viewport が全画面なら ffmpeg を呼ばず元の PNG をそのまま使う
 * （黒帯が無い動画・crop 不要な場面で余計な処理をしないため）。
 * crop する場合は、実際に切り出したピクセル矩形から viewport を作り直した値
 * （actualViewport）を返す。丸め誤差を座標変換に持ち込まないための既定パターン。
 */
async function prepareViewportImage(
  framePngPath: string,
  wantedViewport: NormalizedBox,
  originalPng: Buffer,
  size: { width: number; height: number },
  cropWidth: number,
): Promise<{ base64: string; actualViewport: NormalizedBox; cropped: boolean }> {
  if (isFullViewport(wantedViewport)) {
    return { base64: originalPng.toString("base64"), actualViewport: FULL_VIEWPORT, cropped: false };
  }
  const rect = viewportToPixelRect(wantedViewport, size);
  const actualViewport = pixelRectToViewport(rect, size);
  const width = targetCropWidth(rect.width, cropWidth);
  const buf = await cropFramePng(framePngPath, rect, width);
  return { base64: buf.toString("base64"), actualViewport, cropped: true };
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
        // ---- レターボックス（黒帯）検出。動画1本につき1回だけ ----
        // 既に result.json にキャッシュがあれば ffmpeg を呼ばない（「注釈をやり直す」の高速化）。
        // 検出に失敗しても、以降は FULL_VIEWPORT（従来どおり黒帯込みで見せる）にフォールバックし、
        // 注釈処理自体は止めない（精度改善のための最適化であって必須ではないため）。
        let contentBox = result.contentBox;
        if (contentBox === undefined && DELETTERBOX) {
          try {
            const rect = await detectContentRect(videoPath);
            if (rect) {
              const video = await getVideoInfo(videoPath);
              contentBox = contentViewportFromCropDetect(rect, video) ?? undefined;
            }
          } catch (error) {
            console.error("[annotate] レターボックス検出に失敗しました:", error);
          }
        }
        const contentViewport = contentBox ?? FULL_VIEWPORT;

        send({ type: "start", total: steps.length, rounds: MAX_ROUNDS });

        const current: ManualStepWithMeta[] = [...steps];
        let annotatedCount = 0;

        // ==== 1周目: 全手順を対象に、黒帯除去済みの全体画像で粗く位置推定する ====
        send({ type: "round-start", round: 1, targets: current.length });
        const nextJobs: RefineJob[] = [];

        await mapWithConcurrency(current.map((_, i) => i), CONCURRENCY, async (index) => {
          const step = current[index];
          try {
            const framePngPath = framePath(id, step.time);
            const png = await readFile(framePngPath);
            const size = readPngSize(png);
            if (!size) {
              send({ type: "annotation", round: 1, index, time: step.time, annotation: null, reason: "failed" });
              return;
            }

            // captions[].time と step.time はどちらも toFixed(3) 由来なので厳密一致で引ける
            const caption = result.captions.find((c) => c.time === step.time)?.text;

            const { base64, actualViewport, cropped } = await prepareViewportImage(
              framePngPath,
              contentViewport,
              png,
              size,
              CROP_WIDTH,
            );

            const raw = await annotateStepTarget({
              pngBase64: base64,
              title: step.title,
              description: step.description,
              caption,
              cropped,
            });
            const parsed = parseStepAnnotation(raw, size, { viewport: actualViewport });

            if (!parsed.ok) {
              // 棄却が「モデルが悪い」のか「閾値が厳しすぎる」のか判別できるよう、生の応答も残す
              console.warn(
                `[annotate] 注釈を採用しませんでした（手順${index + 1} / ${step.time}秒 / 1周目 / ${parsed.reason}）: ${raw.slice(0, 200)}`,
              );
              send({ type: "annotation", round: 1, index, time: step.time, annotation: null, reason: parsed.reason });
              return;
            }

            const targets: AnnotationTarget[] = parsed.annotation.targets.map((t) => ({
              ...t,
              refinedAtRound: 1,
            }));
            current[index] = { ...step, annotation: { ...parsed.annotation, targets } };
            annotatedCount++;
            send({ type: "annotation", round: 1, index, time: step.time, annotation: current[index].annotation ?? null });

            // 必ず1回は拡大して確認する（MAX_ROUNDS が2以上のとき）
            if (MAX_ROUNDS >= 2) {
              targets.forEach((_, targetIndex) => nextJobs.push({ stepIndex: index, targetIndex }));
            }
          } catch (error) {
            // 1手順の失敗で全体を止めない（既存 /api/manual/analyze のフレームループと同じ方針）
            console.error(`[annotate] 注釈の生成に失敗しました（${step.time}秒）:`, error);
            send({ type: "annotation", round: 1, index, time: step.time, annotation: null, reason: "failed" });
          }
        });

        send({ type: "round-done", round: 1, annotated: annotatedCount, remaining: nextJobs.length });

        // ==== 2周目以降: crop-and-zoom で個々の target を精緻化する ====
        let jobs = nextJobs;
        for (let round = 2; round <= MAX_ROUNDS && jobs.length > 0; round++) {
          send({ type: "round-start", round, targets: jobs.length });
          const stillPending: RefineJob[] = [];

          await mapWithConcurrency(jobs, CONCURRENCY, async (job) => {
            const step = current[job.stepIndex];
            const annotation = step.annotation;
            const prevTarget = annotation?.targets[job.targetIndex];

            if (annotation && prevTarget) {
              try {
                const size = { width: annotation.frameWidth, height: annotation.frameHeight };
                const zoomV = zoomViewport(prevTarget.box, contentViewport, size);
                const rect = viewportToPixelRect(zoomV, size);
                const actualViewport = pixelRectToViewport(rect, size);
                const width = targetCropWidth(rect.width, CROP_WIDTH);
                const buf = await cropFramePng(framePath(id, step.time), rect, width);

                const raw = await refineStepTarget({
                  pngBase64: buf.toString("base64"),
                  title: step.title,
                  description: step.description,
                  previousLabel: prevTarget.label,
                });
                const parsed = parseStepAnnotation(raw, size, {
                  viewport: actualViewport,
                  maxTargets: 1,
                  maxLocalAreaRatio: MAX_LOCAL_AREA_RATIO,
                });

                if (parsed.ok) {
                  const candidate = parsed.annotation.targets[0];
                  if (isPlausibleRefinement(prevTarget.box, candidate.box)) {
                    // 受理: この target を新しい枠に置き換える
                    const updatedTarget: AnnotationTarget = { ...candidate, refinedAtRound: round };
                    const newTargets = annotation.targets.map((t, i) =>
                      i === job.targetIndex ? updatedTarget : t,
                    );
                    current[job.stepIndex] = { ...step, annotation: { ...annotation, targets: newTargets } };
                    if (round < MAX_ROUNDS && !hasConverged(prevTarget.box, candidate.box)) {
                      stillPending.push(job);
                    }
                  } else {
                    console.warn(
                      `[annotate] 精緻化の結果を採用しませんでした（手順${job.stepIndex + 1} / ${round}周目 / 妥当性NG）`,
                    );
                  }
                }
                // parsed.ok===false（found:false・パース失敗）は、前周の枠をそのまま維持して打ち切る
              } catch (error) {
                console.error(
                  `[annotate] 精緻化に失敗しました（手順${job.stepIndex + 1} / ${round}周目 / ${step.time}秒）:`,
                  error,
                );
                // 失敗も前周の枠を維持して打ち切る
              }
            }

            // その時点での最良の状態（更新後 or 前周のまま）を送る。
            // N周目が found:false でも、前周で確定した正しい枠を null で上書きしない。
            send({
              type: "annotation",
              round,
              index: job.stepIndex,
              time: current[job.stepIndex].time,
              annotation: current[job.stepIndex].annotation ?? null,
            });
          });

          send({ type: "round-done", round, annotated: annotatedCount, remaining: stillPending.length });
          jobs = stillPending;
        }

        const updated: ManualResult = { ...result, steps: current, contentBox };

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
