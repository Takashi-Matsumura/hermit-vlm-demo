/**
 * 操作マニュアル生成のうち、モデルにも ffmpeg にも依存しない純粋な処理。
 * サーバ（/api/manual/analyze）とクライアント（/manual）の両方から import するので、
 * このファイルでは node:* を使わない。Utterance も lib/audio.ts ではなく lib/types.ts から
 * 型として取る（lib/audio.ts は node:child_process を引き込む）。
 */
import type { ManualIntent, ManualStepWithMeta, Utterance } from "@/lib/types";

export type MergedFrameTime = { time: number; fromUtterance: boolean };

/**
 * シーン検出（または等間隔）で選ばれた時刻に、発話の開始時刻を足す。
 * 画面録画ではシーン検出がほとんど反応しないが、ナレーション付き操作動画では
 * 「発話の切れ目 ≒ 1操作」に近いという仮説による。
 *
 * - シーン時刻を先に確定させるので、utterances が空なら selectFrameTimes と結果が完全一致する
 * - minGap より近い時刻は同じ画面とみなして捨てる（1フレーム5〜7秒かかるため）
 * - duration を超える時刻は捨てる（whisper のセグメント終端は尺をわずかに超えることがあり、
 *   そのまま extractFrame に渡すと PNG が出力されず readFile が ENOENT で落ちる）
 */
export function mergeFrameTimes(
  sceneTimes: number[],
  utterances: Utterance[],
  options: { duration: number; maxFrames: number; minGap: number },
): MergedFrameTime[] {
  const { duration, maxFrames, minGap } = options;
  const accepted: MergedFrameTime[] = [];

  const push = (raw: number, fromUtterance: boolean) => {
    // captions[].time / PNGファイル名 / lib/analysis.ts:framePath() の3者を一致させるため、
    // ここで3桁に丸めた値を唯一の正とする
    const time = Number(raw.toFixed(3));
    if (!Number.isFinite(time) || time < 0) return;
    if (duration > 0 && time >= duration - 0.05) return;
    if (accepted.some((a) => Math.abs(a.time - time) < minGap)) return;
    accepted.push({ time, fromUtterance });
  };

  // シーン検出の時刻を先に入れることで、既存デモが見ていたフレームは必ず残る
  for (const t of sceneTimes) push(t, false);
  for (const u of utterances) push(u.start, true);

  accepted.sort((a, b) => a.time - b.time);
  return thinOut(accepted, maxFrames);
}

/** 先頭は必ず残しつつ、maxFrames 以内に等間隔で間引く（lib/video.ts の thinOut と同じ考え方） */
function thinOut(frames: MergedFrameTime[], maxFrames: number): MergedFrameTime[] {
  if (frames.length <= maxFrames) return frames;
  const step = frames.length / maxFrames;
  return Array.from({ length: maxFrames }, (_, i) => frames[Math.floor(i * step)]);
}

/** モデルが返した時刻を、実在するフレームの時刻に寄せる（サムネイル404防止） */
export function snapToFrameTime(time: number, frameTimes: number[]): number {
  return frameTimes.reduce(
    (best, t) => (Math.abs(t - time) < Math.abs(best - time) ? t : best),
    frameTimes[0] ?? 0,
  );
}

/**
 * 同じフレーム（同じスクリーンショット）にスナップされた手順をまとめる。
 * 1画面で複数の入力を続けて行う操作では、モデルが別々の手順として返したものが
 * 同じ PNG を指してしまう（実データで32手順中24手順が9グループに重複した）。
 *
 * キーは time ではなく imageUrl。imageUrl は time.toFixed(3) から作られるので
 * 両者は厳密に等価だが、「同じスクリーンショットならまとめる」という判断基準を
 * そのままコードに残しておく。
 *
 * Map なので配列の離れた位置に同じ imageUrl が現れても1グループにまとまる。
 * 実際には snapToFrameTime が単調非減少なので、時刻順の入力では重複は必ず隣接する。
 * グループの並びは最初に出現した順（= 時刻の昇順）。
 */
export function groupStepsByFrame(steps: ManualStepWithMeta[]): ManualStepWithMeta[][] {
  const groups = new Map<string, ManualStepWithMeta[]>();
  for (const step of steps) {
    const group = groups.get(step.imageUrl);
    if (group) group.push(step);
    else groups.set(step.imageUrl, [step]);
  }
  return [...groups.values()];
}

/** m:ss。app/page.tsx にも同名の関数があるが、既存ファイルは変更しない方針なので共通化していない */
export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** imageUrl（例: /uploads/<id>/frames/f_22.000.png）から末尾のファイル名だけを取り出す */
export function frameFileName(imageUrl: string): string {
  return imageUrl.split("/").pop() ?? imageUrl;
}

/**
 * ZIP の images/ に入れるファイル名。手順番号を前置するのは
 * (1) 同じフレームを指す手順が複数あるとき、注釈違いの画像が上書きされないようにするため
 *     （mergeManualSteps が失敗したグループでは同じ imageUrl の手順が複数残る）
 * (2) 展開したときに images/ が手順順に並ぶため
 *
 * 注釈があるステップは拡張子を .svg にする。ZIP 書き出し（bakeAnnotatedSvg）が
 * 元 PNG を埋め込みつつ赤枠・番号バッジをベクター要素として焼き込むため
 * （注釈が無いステップは元 PNG をそのまま入れるので拡張子も変わらない）。
 */
export function stepImageFileName(step: ManualStepWithMeta, index: number): string {
  const name = frameFileName(step.imageUrl);
  const finalName = step.annotation ? name.replace(/\.png$/i, ".svg") : name;
  return `${String(index + 1).padStart(2, "0")}_${finalName}`;
}

/**
 * 手順を Markdown にする。
 *
 * 画像は同じ ZIP 内の images/ フォルダに配置する前提で、相対パス
 * `images/<ファイル名>` で参照する（サーバの絶対URLには依存しない。
 * ZIP を展開してどこに置いても、フォルダ構成ごと壊さなければ画像が表示される）。
 *
 * intent は意図駆動モード（実況収録から）でのみ渡される。省略時（完成動画モード）は
 * これまでどおりの出力になる。GFM alert（`> [!WARNING]`）ではなく素の `> **注意**` を
 * 使うのは、下の自動生成の注意書きと同じ記法にそろえ、どの Markdown ビューアで開いても
 * 崩れないようにするため。
 */
export function toManualMarkdown(input: {
  title: string;
  summary: string;
  steps: ManualStepWithMeta[];
  intent?: ManualIntent;
}): string {
  const { title, summary, steps, intent } = input;

  const lines: string[] = [
    `# ${intent?.title || title}`,
    "",
    "> この手順書は動画から自動生成されたものです。内容は必ず確認してください。",
    "",
  ];

  if (intent && (intent.audience || intent.goal)) {
    lines.push("## このマニュアルについて", "");
    if (intent.audience) lines.push(`- 対象読者: ${intent.audience}`);
    if (intent.goal) lines.push(`- ゴール: ${intent.goal}`);
    lines.push("");
  }

  if (intent && intent.prerequisites.length > 0) {
    lines.push("## 前提条件", "");
    for (const p of intent.prerequisites) lines.push(`- ${p}`);
    lines.push("");
  }

  if (summary) lines.push("## 概要", "", summary, "");

  if (intent && intent.cautions.length > 0) {
    for (const c of intent.cautions) lines.push(`> **注意** ${c.text}`, ">");
    lines.push("");
  }

  lines.push("## 手順", "");
  steps.forEach((step, i) => {
    lines.push(
      `### ${i + 1}. ${step.title}`,
      "",
      `![手順${i + 1}](images/${stepImageFileName(step, i)})`,
      "",
      step.description,
      "",
    );
    if (step.cautions) {
      for (const c of step.cautions) lines.push(`> **注意** ${c.text}`, ">");
      lines.push("");
    }
    lines.push(`_動画 ${formatTime(step.time)} 付近_`, "");
  });

  return lines.join("\n");
}
