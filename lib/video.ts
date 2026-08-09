/**
 * ffmpeg / ffprobe のラッパー。
 *
 * 注意: このマシンの ffmpeg は freetype 無しビルドなので drawtext は使えない。
 * ここではフレーム抽出とシーン検出しか使っていないため影響はない。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PixelRect } from "@/lib/types";

const run = promisify(execFile);

const SCENE_THRESHOLD = Number(process.env.SCENE_THRESHOLD ?? "0.2");
const MAX_FRAMES = Number(process.env.MAX_FRAMES ?? "16");
/** シーン検出がこの枚数に届かなければ等間隔抽出に切り替える */
const MIN_SCENE_FRAMES = Number(process.env.MIN_SCENE_FRAMES ?? "3");
/** 等間隔抽出のときの目安の間隔(秒) */
const INTERVAL_SECONDS = Number(process.env.INTERVAL_SECONDS ?? "10");
/** 抽出フレームの最大幅。VLM の prompt トークン数と処理時間に直結する */
const FRAME_MAX_WIDTH = Number(process.env.FRAME_MAX_WIDTH ?? "1600");
/** cropdetect の輝度しきい値。24 は ffmpeg の既定値 */
const CROPDETECT_LIMIT = Number(process.env.CROPDETECT_LIMIT ?? "24");

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

/** 先頭は必ず残しつつ、MAX_FRAMES 以内に等間隔で間引く */
function thinOut(times: number[]): number[] {
  if (times.length <= MAX_FRAMES) return times;
  const step = times.length / MAX_FRAMES;
  return Array.from({ length: MAX_FRAMES }, (_, i) => times[Math.floor(i * step)]);
}

export type FrameSelection = {
  times: number[];
  /** scene = シーン検出が使えた / interval = 等間隔にフォールバックした */
  method: "scene" | "interval";
};

/**
 * 解析するフレームの時刻(秒)を決める。
 *
 * まずシーン検出を試すが、画面録画では変化が局所的（メニューが開く、文字が入力される）で
 * 全画面の色ヒストグラム差分がほとんど動かず、閾値をいくら下げても検出できないことが多い。
 * そのため検出数が MIN_SCENE_FRAMES に届かなければ等間隔抽出に切り替える。
 *
 * 先頭フレームは「直前との差分」が存在せず検出されないので、必ず 0 を先頭に付ける。
 */
export async function selectFrameTimes(videoPath: string): Promise<FrameSelection> {
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

  const sceneTimes = [0, ...detected];
  if (sceneTimes.length >= MIN_SCENE_FRAMES) {
    return { times: thinOut(sceneTimes), method: "scene" };
  }

  const { duration } = await getVideoInfo(videoPath);
  if (!Number.isFinite(duration) || duration <= 0) {
    return { times: [0], method: "interval" };
  }

  // 尺に応じた枚数を等間隔に取る。0 から始めて step ずつ進めるので、
  // 最後は duration - step となり、末尾の黒フレームを踏まない。
  const count = Math.min(MAX_FRAMES, Math.max(MIN_SCENE_FRAMES, Math.round(duration / INTERVAL_SECONDS)));
  const step = duration / count;
  const times = Array.from({ length: count }, (_, i) => Number((i * step).toFixed(3)));

  return { times, method: "interval" };
}

/**
 * 指定時刻のフレームを PNG で書き出す。
 *
 * 高解像度のフレームをそのまま渡すと VLM の prompt トークンが跳ね上がる。
 * 2880x1800 では 4,039 tok / 59.7秒 かかったものが、1600px に縮めると
 * 1,589 tok / 30.9秒 になり、画面内の文字は変わらず読み取れた。
 * そのため FRAME_MAX_WIDTH を上限に縮小する（元より大きくは拡大しない）。
 *
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
    "-vf", `scale='min(${FRAME_MAX_WIDTH},iw)':-2`,
    "-update", "1",
    outPath,
  ]);
}

type CropDetectFrame = {
  tags?: {
    "lavfi.cropdetect.w"?: string;
    "lavfi.cropdetect.h"?: string;
    "lavfi.cropdetect.x"?: string;
    "lavfi.cropdetect.y"?: string;
  };
};

/**
 * 画面録画の左右（または上下）の黒帯（レターボックス）を検出する。
 * 注釈サブエージェント（/api/manual/annotate）が、VLM に渡す前にこの領域だけへ
 * トリミングすることで、黒帯ぶんの画素をグラウンディングの精度低下に繋げないようにする。
 *
 * fps=1 に間引いてから cropdetect に通すことで負荷を抑える
 * （デコード自体は全フレーム走るが、実測 460秒/13787フレームの動画で 1.36秒）。
 * reset=0 なので最後のタグ付きフレームが動画全体の累積結果になる
 * （暗い/フェードインするフレームで一時的に誤検出しても、明るいフレームが
 * 1枚あれば最終的に正しい値に上書きされる）。
 *
 * 黒帯が無い、または検出に失敗した場合は null を返す。呼び出し側は
 * 「黒帯除去なしで従来どおり動く」にフォールバックすること
 * （精度改善のための最適化であって、これが失敗しても注釈処理自体は止めるべきではない）。
 */
export async function detectContentRect(videoPath: string): Promise<PixelRect | null> {
  let stdout: string;
  try {
    ({ stdout } = await run("ffprobe", [
      "-v", "error",
      "-f", "lavfi",
      `movie=${escapeForLavfi(videoPath)},fps=1,cropdetect=limit=${CROPDETECT_LIMIT}:round=2:reset=0`,
      "-show_entries", "frame_tags=lavfi.cropdetect.w,lavfi.cropdetect.h,lavfi.cropdetect.x,lavfi.cropdetect.y",
      "-of", "json",
    ], { maxBuffer: 32 * 1024 * 1024 }));
  } catch (error) {
    console.error("[video] cropdetect の実行に失敗しました:", error);
    return null;
  }

  let parsed: { frames?: CropDetectFrame[] };
  try {
    parsed = JSON.parse(stdout) as { frames?: CropDetectFrame[] };
  } catch {
    return null;
  }

  // -of csv は列順がタグ順ではなく内部順になるため使わない（json なら key で引ける）。
  // 末尾から探すのは、reset=0 の累積結果が最後のタグ付きフレームに乗っているため。
  const frames = parsed.frames ?? [];
  for (let i = frames.length - 1; i >= 0; i--) {
    const tags = frames[i].tags;
    if (!tags) continue;
    const w = Number(tags["lavfi.cropdetect.w"]);
    const h = Number(tags["lavfi.cropdetect.h"]);
    const x = Number(tags["lavfi.cropdetect.x"]);
    const y = Number(tags["lavfi.cropdetect.y"]);
    if (![w, h, x, y].every((n) => Number.isFinite(n))) continue;
    return { x, y, width: w, height: h };
  }
  return null;
}

/**
 * フレーム PNG の一部を切り出して拡大し、PNG のまま標準出力で受け取る。
 * 元動画へシークし直さないのは、フレーム PNG が既に取りうる最大解像度
 * （FRAME_MAX_WIDTH 上限。この素材では等倍）を持っているため。
 * 中間ファイルを作らないので、注釈サブエージェントの並列実行と競合しない。
 * ffmpeg は freetype 無しビルドだが、crop/scale は文字を描かないので影響しない。
 */
export async function cropFramePng(
  pngPath: string,
  rect: PixelRect,
  targetWidth: number,
): Promise<Buffer> {
  const { stdout } = await run("ffmpeg", [
    "-v", "error",
    "-i", pngPath,
    "-vf", `crop=${rect.width}:${rect.height}:${rect.x}:${rect.y},scale=${targetWidth}:-2:flags=lanczos`,
    "-frames:v", "1",
    "-f", "image2pipe",
    "-vcodec", "png",
    "-",
  ], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}
