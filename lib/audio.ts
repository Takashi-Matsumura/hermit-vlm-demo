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

    return (parsed.transcription ?? [])
      .map((seg) => ({
        start: seg.offsets.from / 1000,
        end: seg.offsets.to / 1000,
        text: seg.text.trim(),
      }))
      .filter((u) => u.text.length > 0);
  } finally {
    // 中間ファイルは result.json に書き起こし結果を保存すれば不要なので都度消す
    await unlink(wavPath).catch(() => {});
    await unlink(`${jsonBase}.json`).catch(() => {});
  }
}
