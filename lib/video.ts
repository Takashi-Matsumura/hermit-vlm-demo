/**
 * ffmpeg / ffprobe のラッパー。
 *
 * 注意: このマシンの ffmpeg は freetype 無しビルドなので drawtext は使えない。
 * ここではフレーム抽出とシーン検出しか使っていないため影響はない。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const SCENE_THRESHOLD = Number(process.env.SCENE_THRESHOLD ?? "0.2");
const MAX_FRAMES = Number(process.env.MAX_FRAMES ?? "16");

export type VideoInfo = { duration: number; width: number; height: number };

export async function getVideoInfo(videoPath: string): Promise<VideoInfo> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-show_entries", "format=duration",
    "-of", "json",
    videoPath,
  ]);

  const parsed = JSON.parse(stdout) as {
    streams?: { width?: number; height?: number }[];
    format?: { duration?: string };
  };
  const stream = parsed.streams?.[0];

  return {
    duration: Number(parsed.format?.duration ?? 0),
    width: stream?.width ?? 0,
    height: stream?.height ?? 0,
  };
}

/**
 * lavfi の movie= フィルタはパス中の特殊文字をフィルタ構文として解釈するのでエスケープする。
 */
function escapeForLavfi(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/**
 * シーンが切り替わる時刻(秒)を返す。
 *
 * 先頭フレームは「直前との差分」が存在せず検出されないため、必ず 0 を先頭に付ける。
 * 検出数が MAX_FRAMES を超えたら等間隔に間引く（長い動画で推論が終わらなくなるのを防ぐ）。
 */
export async function detectScenes(videoPath: string): Promise<number[]> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-f", "lavfi",
    `movie=${escapeForLavfi(videoPath)},select=gt(scene\\,${SCENE_THRESHOLD})`,
    "-show_entries", "frame=pts_time",
    "-of", "csv=p=0",
  ], { maxBuffer: 32 * 1024 * 1024 });

  const detected = stdout
    .split("\n")
    .map((line) => Number(line.replace(/,/g, "").trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  const times = [0, ...detected];
  if (times.length <= MAX_FRAMES) return times;

  // 先頭は必ず残しつつ等間隔に間引く
  const step = times.length / MAX_FRAMES;
  return Array.from({ length: MAX_FRAMES }, (_, i) => times[Math.floor(i * step)]);
}

/**
 * 指定時刻のフレームを PNG で書き出す。
 * ffmpeg 8 では単一画像出力に -update 1 が必要（無いと image2 muxer が警告を出す）。
 */
export async function extractFrame(
  videoPath: string,
  time: number,
  outPath: string,
): Promise<void> {
  await run("ffmpeg", [
    "-y",
    "-ss", String(time),
    "-i", videoPath,
    "-frames:v", "1",
    "-update", "1",
    outPath,
  ]);
}
