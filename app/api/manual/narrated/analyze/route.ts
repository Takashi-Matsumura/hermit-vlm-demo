import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { transcribe } from "@/lib/audio";
import {
  captionOperationFrame,
  embed,
  outlineUtteranceChunk,
  reduceManualOutline,
  summarize,
  writeNarratedStep,
} from "@/lib/llm";
import { mapWithConcurrency } from "@/lib/concurrency";
import {
  assignCautionsToSteps,
  chunkUtterances,
  coverageRatio,
  dedupeCautions,
  formatUtteranceLines,
  normalizeOutlineGroups,
  parseOutlineChunk,
  parseOutlineReduce,
  repairOutlineGaps,
  selectPlannedFrameTimes,
  utteranceRangeToTimeSpan,
} from "@/lib/intent";
import type { UtteranceChunkRange } from "@/lib/intent";
import { extractFrame, getVideoInfo } from "@/lib/video";
import type {
  Caption,
  Caution,
  ManualIntent,
  ManualNarratedEvent,
  ManualResult,
  ManualStepWithMeta,
  PlannedStep,
  Utterance,
} from "@/lib/types";

// ffmpeg / whisper.cpp の起動と fs 書き込みを行うので Node.js ランタイムで動かす
export const runtime = "nodejs";

const UPLOAD_ROOT = path.join(process.cwd(), "public", "uploads");

/** 動画は arrayBuffer() で一旦メモリに載せるので、上限を決めておかないと簡単に落とせる */
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? "500");
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

/**
 * 発話チャンクの最大件数。実測: 85件のチャンクは被覆100%、400件を一括投入すると
 * 被覆21%まで崩壊する。コンテキスト長には余裕がある（gemma の n_ctx は262k/スロット）ので、
 * これはモデルの「まとめ漏れ」に対する品質ゲートであり、コンテキスト制限ではない。
 */
const MANUAL_INTENT_CHUNK_SIZE = Number(process.env.MANUAL_INTENT_CHUNK_SIZE ?? "90");
/** チャンク境界で話題が分断されないよう隣接チャンクに持たせる重なり幅(発話数) */
const MANUAL_INTENT_CHUNK_OVERLAP = Number(process.env.MANUAL_INTENT_CHUNK_OVERLAP ?? "2");
/** reduce 結果の被覆率がこれを下回ったら、局所アウトラインをそのまま採用する */
const MANUAL_INTENT_MIN_COVERAGE = Number(process.env.MANUAL_INTENT_MIN_COVERAGE ?? "0.7");
/** 1手順あたりの候補フレーム数。1枚5〜7秒かかるので待ち時間に直結する */
const MANUAL_NARRATED_FRAMES_PER_STEP = Number(process.env.MANUAL_NARRATED_FRAMES_PER_STEP ?? "2");
/** map フェーズ・素材収集フェーズの並列度（1スロットは QaChat 用に空ける。annotate と同じ考え方） */
const MANUAL_NARRATED_CONCURRENCY = Number(process.env.MANUAL_NARRATED_CONCURRENCY ?? "3");

/** 被覆漏れの区間がこの発話数未満なら、1〜2件のノイズとみなして補わない */
const MIN_GAP_UTTERANCES = 2;
/** 候補フレーム時刻がこれ未満しか離れていなければ同じ画面とみなして捨てる(秒) */
const MIN_FRAME_GAP_SECONDS = 2;

/**
 * map フェーズ（outlineUtteranceChunk）のパースに失敗したときの決定論的フォールバック。
 * 8発話ずつの等分連続範囲に割り、title は先頭発話の先頭30文字にする
 * （lib/llm.ts の splitChapters / generateManualSteps と同じ「1フレーム=1章」的な考え方）。
 */
function fallbackChunkOutline(utterances: Utterance[], range: UtteranceChunkRange): PlannedStep[] {
  const GROUP_SIZE = 8;
  const items: PlannedStep[] = [];
  for (let from = range.from; from <= range.to; from += GROUP_SIZE) {
    const to = Math.min(from + GROUP_SIZE - 1, range.to);
    items.push({ title: utterances[from].text.slice(0, 30), intent: "", from, to });
  }
  return items;
}

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

  // lavfi の movie= に渡すので拡張子を含めた固定名にしておく（analyze/route.ts と同じ理由）
  const videoPath = path.join(dir, "video.mp4");
  await writeFile(videoPath, Buffer.from(await file.arrayBuffer()));
  const fallbackTitle = file.name.replace(/\.[^./]+$/, "").trim() || "操作マニュアル";

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ManualNarratedEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        const info = await getVideoInfo(videoPath);
        const utterances = await transcribe(videoPath, dir);

        // このモードは全文文字起こしが設計の土台。完成動画モードと違い、音声が無ければ
        // 静かに劣化させず、ここで打ち切る（README「誤りを黙って通すより正直に言う」方針）。
        if (utterances.length === 0) {
          send({
            type: "error",
            message:
              "音声が検出されませんでした。実況収録モードは音声の書き起こしが前提です。" +
              "WHISPER_MODEL の設定と、動画に音声トラックがあるかを確認してください。",
          });
          return;
        }

        const chunks = chunkUtterances(utterances.length, {
          maxPerChunk: MANUAL_INTENT_CHUNK_SIZE,
          overlap: MANUAL_INTENT_CHUNK_OVERLAP,
        });

        send({
          type: "info",
          id,
          videoUrl: `/uploads/${id}/video.mp4`,
          duration: info.duration,
          utteranceCount: utterances.length,
          chunkCount: chunks.length,
        });
        send({ type: "utterances", utterances });

        // --- パス1a: map（チャンクごとの局所アウトライン） ---
        const localItemsPerChunk: PlannedStep[][] = chunks.map(() => []);
        const cautionsPerChunk: Caution[][] = chunks.map(() => []);

        await mapWithConcurrency(chunks, MANUAL_NARRATED_CONCURRENCY, async (range, index) => {
          try {
            const lines = formatUtteranceLines(utterances, range);
            const raw = await outlineUtteranceChunk({ lines, from: range.from, to: range.to });
            const parsed = parseOutlineChunk(raw, range);
            if (parsed.ok) {
              localItemsPerChunk[index] = parsed.items;
              cautionsPerChunk[index] = parsed.cautions;
            } else {
              localItemsPerChunk[index] = fallbackChunkOutline(utterances, range);
            }
          } catch (error) {
            console.error(`[manual/narrated] チャンク ${range.from}-${range.to} の意図抽出に失敗しました:`, error);
            localItemsPerChunk[index] = fallbackChunkOutline(utterances, range);
          }
          send({ type: "chunk", index, total: chunks.length, items: localItemsPerChunk[index].length });
        });

        const localItems = localItemsPerChunk.flat();
        const chunkCautions = dedupeCautions(cautionsPerChunk.flat());

        // --- パス1b: reduce（局所アウトラインの統合） ---
        let planned: PlannedStep[];
        let header = { title: "", audience: "", goal: "", prerequisites: [] as string[] };

        try {
          const itemsText = localItems.map((it, i) => `#${i} ${it.title} / ${it.intent}`).join("\n");
          const rawReduce = await reduceManualOutline({ items: itemsText });
          const parsedReduce = parseOutlineReduce(rawReduce, localItems.length);
          if (!parsedReduce.ok) throw new Error("reduce のパースに失敗しました");

          const normalized = normalizeOutlineGroups(parsedReduce.groups, localItems);
          const ratio = coverageRatio(normalized, utterances.length);

          if (ratio < MANUAL_INTENT_MIN_COVERAGE) {
            // 被覆率が閾値未満なら reduce 結果を信用せず、局所アウトラインをそのまま採用する
            // （実測: 発話400件の一括投入で被覆0.21まで崩壊した。この崩壊を機械的に検出する）
            console.error(
              `[manual/narrated] reduce の被覆率が閾値(${MANUAL_INTENT_MIN_COVERAGE})未満です（${ratio.toFixed(2)}）。局所アウトラインを採用します。`,
            );
            planned = localItems;
          } else {
            planned = normalized;
            header = parsedReduce.header;
          }
        } catch (error) {
          console.error("[manual/narrated] アウトラインの統合に失敗しました:", error);
          planned = localItems; // 恒等 reduce（合成できなくても局所アウトラインの情報は落とさない）
        }

        planned = repairOutlineGaps(planned, utterances.length, MIN_GAP_UTTERANCES);

        const { stepCautions, documentCautions } = assignCautionsToSteps(chunkCautions, planned);

        const intent: ManualIntent = {
          title: header.title || fallbackTitle,
          audience: header.audience,
          goal: header.goal,
          prerequisites: header.prerequisites,
          cautions: documentCautions,
        };
        send({ type: "intent", intent });
        send({ type: "plan", planned });

        // --- パス2: 各計画項目について、根拠区間から素材を集めて手順本文を書く ---

        // 候補フレーム時刻は手順間で重複しないよう、並列実行の前に順番に確定させる
        // （selectPlannedFrameTimes の existing 引数はここまでに決めた時刻の一覧）
        const plannedFrameTimes: number[][] = [];
        const decidedTimes: number[] = [];
        for (const p of planned) {
          const span = utteranceRangeToTimeSpan({ from: p.from, to: p.to }, utterances, info.duration);
          let times = selectPlannedFrameTimes(span, {
            duration: info.duration,
            perStep: MANUAL_NARRATED_FRAMES_PER_STEP,
            minGap: MIN_FRAME_GAP_SECONDS,
            existing: decidedTimes,
          });
          if (times.length === 0) {
            // 全候補が既存フレームと重複して間引かれた場合でも、この手順には必ず1回は
            // 抽出を試みる（imageUrl が実在しないファイルを指すのを防ぐため）
            const fallback = Number(
              Math.max(0, Math.min(span.start, info.duration > 0 ? info.duration - 0.05 : span.start)).toFixed(3),
            );
            times = [fallback];
          }
          plannedFrameTimes.push(times);
          decidedTimes.push(...times);
        }

        const totalCaptures = plannedFrameTimes.reduce((sum, t) => sum + t.length, 0);
        const allCaptions: Caption[] = [];
        const steps: (ManualStepWithMeta | undefined)[] = new Array(planned.length);

        await mapWithConcurrency(planned, MANUAL_NARRATED_CONCURRENCY, async (p, index) => {
          const times = plannedFrameTimes[index];
          const frameCaptions: Caption[] = [];

          for (const time of times) {
            try {
              const fileName = `f_${time.toFixed(3)}.png`;
              const framePath = path.join(framesDir, fileName);
              await extractFrame(videoPath, time, framePath);
              const png = await readFile(framePath);
              const text = await captionOperationFrame(png.toString("base64"));
              const caption: Caption = { time, text };
              frameCaptions.push(caption);
              allCaptions.push(caption);
            } catch (error) {
              // ffmpeg のシーク実装依存で特定時刻の抽出が失敗することがある（analyze/route.ts と同じ理由）。
              // この手順の1枚が失敗しただけで解析全体を止めない。
              console.error(`[manual/narrated] フレーム抽出/言語化に失敗しました（${time}秒）:`, error);
            }
            send({
              type: "capture",
              stepIndex: index,
              total: totalCaptures,
              time,
              imageUrl: `/uploads/${id}/frames/f_${time.toFixed(3)}.png`,
              text: frameCaptions.at(-1)?.text ?? "",
            });
          }

          if (frameCaptions.length === 0) {
            // この手順の代表画像が1枚も作れなかった。実在しない画像を指す手順を作るくらいなら、
            // 手順ごと落とす方が安全（README「誤った枠を描くくらいなら描かない」と同じ判断）。
            console.error(`[manual/narrated] 手順「${p.title}」の画像を1枚も抽出できませんでした。この手順は省略します。`);
            return;
          }

          const utteranceText = utterances
            .slice(p.from, p.to + 1)
            .map((u) => u.text)
            .join(" ");

          const { title, description } = await writeNarratedStep({
            planTitle: p.title,
            planIntent: p.intent,
            utteranceText,
            frameCaptions: frameCaptions.map((c) => c.text),
          });

          const time = frameCaptions[0].time;
          const step: ManualStepWithMeta = {
            time,
            title,
            description,
            imageUrl: `/uploads/${id}/frames/f_${time.toFixed(3)}.png`,
            sourceUtterances: { from: p.from, to: p.to },
            cautions: stepCautions[index].length > 0 ? stepCautions[index] : undefined,
          };
          steps[index] = step;

          send({ type: "step", index, step });
        });

        const finalSteps = steps.filter((s): s is ManualStepWithMeta => s !== undefined);

        const summary = await summarize(allCaptions, utterances);
        send({ type: "summary", text: summary });

        const [captionEmbeddings, utteranceEmbeddings] = await Promise.all([
          embed(allCaptions.map((c) => c.text)),
          embed(utterances.map((u) => u.text)),
        ]);

        const result: ManualResult = {
          id,
          videoUrl: `/uploads/${id}/video.mp4`,
          duration: info.duration,
          method: "planned",
          mode: "narrated",
          summary,
          chapters: finalSteps.map((s) => ({ start: s.time, title: s.title })),
          captions: allCaptions.map((c, i) => ({
            ...c,
            imageUrl: `/uploads/${id}/frames/f_${c.time.toFixed(3)}.png`,
            embedding: captionEmbeddings[i] ?? [],
          })),
          utterances: utterances.map((u, i) => ({
            ...u,
            embedding: utteranceEmbeddings[i] ?? [],
          })),
          steps: finalSteps,
          intent,
        };
        await writeFile(path.join(dir, "result.json"), JSON.stringify(result));

        send({ type: "done", id });
      } catch (error) {
        // ffmpeg や fetch の例外にはローカルの絶対パスやエンドポイントが載るため、
        // 詳細はサーバログにだけ出してクライアントには汎用メッセージを返す
        console.error("[manual/narrated] 解析に失敗しました:", error);
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
