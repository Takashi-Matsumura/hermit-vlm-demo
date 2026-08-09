/**
 * 音声の書き起こし。whisper.cpp (whisper-cli) を都度起動して使う。
 *
 * whisper-cli のモデルロードは実測 137ms 程度と軽量で、32秒の動画の文字起こし全体でも
 * 3秒程度しかかからない。llama-server のような常駐サーバ化は割に合わないため、
 * lib/video.ts と同じ execFile 都度起動のパターンを踏襲する。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);

/** マシン固有のモデルパスなので既定値は持たない。未設定なら音声認識機能そのものを無効化する */
const WHISPER_MODEL = process.env.WHISPER_MODEL;
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE ?? "ja";

export type Utterance = { start: number; end: number; text: string };

/**
 * 同一テキストがこの秒数以内に再出現したら、ハルシネーションループとみなして間引く。
 * 実測（460秒の操作説明動画）では「郵便番号から、ご依頼主を入力しました。」が
 * 217〜286秒の間に21回、「印刷済みの送り状が確認できます。」が「閉じるをクリックします。」を
 * 挟みながら419〜460秒の間に11回、いずれも数秒間隔で繰り返された。
 */
const REPEAT_WINDOW_SECONDS = 20;

/**
 * whisper.cpp は無音区間や単調な音声区間で、直前の出力を延々と繰り返す
 * ハルシネーションループを起こすことがある（既知の不具合）。この水増しされた発話は
 * 手順生成のプロンプト（lib/llm.ts の buildContext）を不必要に長くし、LLM の応答生成が
 * 異常に長引く原因になる（lib/llm.ts の postJson が既定300秒でタイムアウトし、
 * 解析全体が失敗する）ため、書き起こし直後に間引く。
 *
 * テキストごとに直前の出現時刻を覚えておき、REPEAT_WINDOW_SECONDS 以内の再出現を捨てる。
 * 捨てた発話の時刻も基準に含める（前回「見た」時刻を更新し続ける）ことで、
 * 数秒おきに長く続くループも1件にまとまる。
 */
export function dedupeRepeatedUtterances(utterances: Utterance[]): Utterance[] {
  const lastSeenAt = new Map<string, number>();
  const result: Utterance[] = [];

  for (const u of utterances) {
    const lastStart = lastSeenAt.get(u.text);
    const isRepeat = lastStart !== undefined && u.start - lastStart < REPEAT_WINDOW_SECONDS;
    lastSeenAt.set(u.text, u.start);
    if (!isRepeat) result.push(u);
  }

  return result;
}

/** 動画に音声トラックがあるか判定する */
async function hasAudioTrack(videoPath: string): Promise<boolean> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "a",
    "-show_entries", "stream=index",
    "-of", "csv=p=0",
    videoPath,
  ]);
  return stdout.trim().length > 0;
}

type WhisperJson = {
  transcription?: { offsets: { from: number; to: number }; text: string }[];
};

/**
 * 動画から音声を書き起こす。
 * 音声トラックが無い、WHISPER_MODEL が未設定、whisper-cli が失敗した場合は
 * いずれも空配列を返す（呼び出し元は動画解析全体を止めない）。
 */
export async function transcribe(videoPath: string, workDir: string): Promise<Utterance[]> {
  if (!WHISPER_MODEL) return [];
  if (!(await hasAudioTrack(videoPath))) return [];

  const wavPath = path.join(workDir, "audio.wav");
  const jsonBase = path.join(workDir, "audio");

  try {
    await run("ffmpeg", [
      "-y", "-v", "error",
      "-i", videoPath,
      "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
      wavPath,
    ]);

    await run("whisper-cli", [
      "-m", WHISPER_MODEL,
      "-f", wavPath,
      "-l", WHISPER_LANGUAGE,
      "-oj", "-of", jsonBase,
      "--no-prints",
    ], { maxBuffer: 32 * 1024 * 1024 });

    const raw = await readFile(`${jsonBase}.json`, "utf-8");
    const parsed = JSON.parse(raw) as WhisperJson;

    const segments = (parsed.transcription ?? [])
      .map((seg) => ({
        start: seg.offsets.from / 1000,
        end: seg.offsets.to / 1000,
        text: seg.text.trim(),
      }))
      .filter((u) => u.text.length > 0);

    return dedupeRepeatedUtterances(segments);
  } finally {
    // 中間ファイルは result.json に書き起こし結果を保存すれば不要なので都度消す
    await unlink(wavPath).catch(() => {});
    await unlink(`${jsonBase}.json`).catch(() => {});
  }
}
