import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { transcribe } from "@/lib/audio";
import { captionOperationFrame, embed, generateManualSteps, mergeManualSteps, summarize } from "@/lib/llm";
import { groupStepsByFrame, mergeFrameTimes, snapToFrameTime } from "@/lib/manual";
import { extractFrame, getVideoInfo, selectFrameTimes } from "@/lib/video";
import type { Caption, ManualAnalyzeEvent, ManualResult, ManualStepWithMeta } from "@/lib/types";

// ffmpeg / whisper.cpp の起動と fs 書き込みを行うので Node.js ランタイムで動かす
export const runtime = "nodejs";

const UPLOAD_ROOT = path.join(process.cwd(), "public", "uploads");

/** 動画は arrayBuffer() で一旦メモリに載せるので、上限を決めておかないと簡単に落とせる */
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? "500");
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

/** 発話の区切れ目を足したあとのフレーム数上限。1枚5〜7秒かかるので待ち時間に直結する */
const MANUAL_MAX_FRAMES = Number(process.env.MANUAL_MAX_FRAMES ?? "24");
/** これより近い時刻は同じ画面とみなして捨てる(秒) */
const MANUAL_MIN_FRAME_GAP = Number(process.env.MANUAL_MIN_FRAME_GAP ?? "2");

export async function POST(request: Request): Promise<Response> {
  const formData = await request.formData();
  const file = formData.get("video");

  if (!(file instanceof File)) {
    return Response.json({ error: "動画ファイルが指定されていません" }, { status: 400 });
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json(
      { error: `動画は ${MAX_UPLOAD_MB}MB 以下にしてください` },
      { status: 413 },
    );
  }

  const id = randomUUID();
  const dir = path.join(UPLOAD_ROOT, id);
  const framesDir = path.join(dir, "frames");
  await mkdir(framesDir, { recursive: true });

  // lavfi の movie= に渡すので拡張子を含めた固定名にしておく
  const videoPath = path.join(dir, "video.mp4");
  await writeFile(videoPath, Buffer.from(await file.arrayBuffer()));

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ManualAnalyzeEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        const info = await getVideoInfo(videoPath);

        // シーン検出は動画全体をデコードするので、文字起こしと並行に走らせる。
        // 文字起こしの失敗（音声なし・WHISPER_MODEL 未設定を含む）では解析を止めない。
        const [selection, utterances] = await Promise.all([
          selectFrameTimes(videoPath),
          transcribe(videoPath, dir).catch((error) => {
            console.error("[manual] 文字起こしに失敗しました:", error);
            return [];
          }),
        ]);

        const frames = mergeFrameTimes(selection.times, utterances, {
          duration: info.duration,
          maxFrames: MANUAL_MAX_FRAMES,
          minGap: MANUAL_MIN_FRAME_GAP,
        });

        send({
          type: "info",
          id,
          videoUrl: `/uploads/${id}/video.mp4`,
          duration: info.duration,
          frameCount: frames.length,
          method: selection.method,
          utteranceCount: utterances.length,
          utteranceFrameCount: frames.filter((f) => f.fromUtterance).length,
        });

        // 字幕はこの時点で確定しているので、数分かかるフレームループの前に出す
        if (utterances.length > 0) {
          send({ type: "utterances", utterances });
        }

        const captions: Caption[] = [];
        for (const [index, frame] of frames.entries()) {
          const fileName = `f_${frame.time.toFixed(3)}.png`;
          const framePath = path.join(framesDir, fileName);

          try {
            await extractFrame(videoPath, frame.time, framePath);
            const png = await readFile(framePath);
            const text = await captionOperationFrame(png.toString("base64"));

            captions.push({ time: frame.time, text });
            send({
              type: "caption",
              index,
              time: frame.time,
              text,
              imageUrl: `/uploads/${id}/frames/${fileName}`,
              fromUtterance: frame.fromUtterance,
            });
          } catch (error) {
            // ffmpeg のシーク実装依存で、キーフレーム情報が壊れた一部の動画
            // （古い ffmpeg2theora 製 Ogg 等）では特定時刻の抽出が失敗することがある。
            // 1枚失敗しただけで数分かかる解析全体を止めないよう、そのフレームだけスキップする。
            console.error(`[manual] フレーム抽出/言語化に失敗しました（${frame.time}秒）:`, error);
          }
        }

        const [summary, rawSteps] = await Promise.all([
          summarize(captions, utterances),
          generateManualSteps(captions, utterances),
        ]);

        // 手順の統合に十数秒かかるので、確定済みの要約は先に出す
        send({ type: "summary", text: summary });

        // モデルが返す time は説明文から拾った近似値なので、実在するフレームの時刻に寄せる。
        // これで imageUrl が必ず存在し、/api/ask のフレーム参照とも時刻がそろう。
        const frameTimes = frames.map((f) => f.time);
        const snappedSteps: ManualStepWithMeta[] = rawSteps.map((step) => {
          const time = snapToFrameTime(step.time, frameTimes);
          return { ...step, time, imageUrl: `/uploads/${id}/frames/f_${time.toFixed(3)}.png` };
        });

        // 1つの画面で続けて入力する操作は、モデルが別々の手順として返しても同じフレームに
        // スナップされる（実測で32手順中24手順が9グループに重なった）。同じ画面の操作は
        // まとめて1手順にする。グループは高々フレーム数なので並行に投げる。
        const stepGroups = await Promise.all(
          groupStepsByFrame(snappedSteps).map(async (group): Promise<ManualStepWithMeta[]> => {
            if (group.length === 1) return group;
            try {
              const { title, description } = await mergeManualSteps(group);
              // time と imageUrl はグループ内で同一なので先頭のものをそのまま使う
              return [{ ...group[0], title, description }];
            } catch (error) {
              // 統合は後処理なので、失敗したグループは統合前のまま残して解析は続ける
              console.error(`[manual] 手順の統合に失敗しました（${group[0].time}秒）:`, error);
              return group;
            }
          }),
        );
        const steps: ManualStepWithMeta[] = stepGroups.flat();

        send({ type: "steps", steps });

        // 検索用のベクトルは結果と一緒に保存し、/api/search から読み出す
        const [captionEmbeddings, utteranceEmbeddings] = await Promise.all([
          embed(captions.map((c) => c.text)),
          utterances.length > 0 ? embed(utterances.map((u) => u.text)) : Promise.resolve([]),
        ]);

        const result: ManualResult = {
          id,
          videoUrl: `/uploads/${id}/video.mp4`,
          duration: info.duration,
          method: selection.method,
          summary,
          // 章は手順から作る。gemma をもう1回呼ばずに AnalysisResult の形を満たせる
          chapters: steps.map((s) => ({ start: s.time, title: s.title })),
          captions: captions.map((c, i) => ({
            ...c,
            imageUrl: `/uploads/${id}/frames/f_${c.time.toFixed(3)}.png`,
            embedding: captionEmbeddings[i] ?? [],
          })),
          utterances: utterances.map((u, i) => ({
            ...u,
            embedding: utteranceEmbeddings[i] ?? [],
          })),
          steps,
        };
        await writeFile(path.join(dir, "result.json"), JSON.stringify(result));

        send({ type: "done", id });
      } catch (error) {
        // ffmpeg や fetch の例外にはローカルの絶対パスやエンドポイントが載るため、
        // 詳細はサーバログにだけ出してクライアントには汎用メッセージを返す
        console.error("[manual] 解析に失敗しました:", error);
        send({
          type: "error",
          message: "解析に失敗しました。サーバのログを確認してください。",
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
