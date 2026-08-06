import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { captionFrame, embed, splitChapters, summarize } from "@/lib/llm";
import { extractFrame, getVideoInfo, selectFrameTimes } from "@/lib/video";
import type { AnalysisResult, AnalyzeEvent, Caption } from "@/lib/types";

// ffmpeg の起動と fs 書き込みを行うので Node.js ランタイムで動かす
export const runtime = "nodejs";

const UPLOAD_ROOT = path.join(process.cwd(), "public", "uploads");

/** 動画は arrayBuffer() で一旦メモリに載せるので、上限を決めておかないと簡単に落とせる */
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? "500");
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

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
      const send = (event: AnalyzeEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        const info = await getVideoInfo(videoPath);
        const { times, method } = await selectFrameTimes(videoPath);

        send({
          type: "info",
          id,
          videoUrl: `/uploads/${id}/video.mp4`,
          duration: info.duration,
          frameCount: times.length,
          method,
        });

        const captions: Caption[] = [];

        for (const [index, time] of times.entries()) {
          const fileName = `f_${time.toFixed(3)}.png`;
          const framePath = path.join(framesDir, fileName);

          await extractFrame(videoPath, time, framePath);
          const png = await readFile(framePath);
          const text = await captionFrame(png.toString("base64"));

          captions.push({ time, text });
          send({
            type: "caption",
            index,
            time,
            text,
            imageUrl: `/uploads/${id}/frames/${fileName}`,
          });
        }

        // 要約と章分割は同じタイムラインを入力にするので並行して走らせる
        const [summary, chapters] = await Promise.all([
          summarize(captions),
          splitChapters(captions),
        ]);
        send({ type: "summary", text: summary });
        send({ type: "chapters", chapters });

        // 検索用のベクトルは結果と一緒に保存し、/api/search から読み出す
        const embeddings = await embed(captions.map((c) => c.text));
        const result: AnalysisResult = {
          id,
          videoUrl: `/uploads/${id}/video.mp4`,
          duration: info.duration,
          method,
          summary,
          chapters,
          captions: captions.map((c, i) => ({
            ...c,
            imageUrl: `/uploads/${id}/frames/f_${c.time.toFixed(3)}.png`,
            embedding: embeddings[i] ?? [],
          })),
        };
        await writeFile(path.join(dir, "result.json"), JSON.stringify(result));

        send({ type: "done", id });
      } catch (error) {
        // ffmpeg や fetch の例外にはローカルの絶対パスやエンドポイントが載るため、
        // 詳細はサーバログにだけ出してクライアントには汎用メッセージを返す
        console.error("[analyze] 解析に失敗しました:", error);
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
