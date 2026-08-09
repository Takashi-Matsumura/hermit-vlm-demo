/**
 * スクリーンショット検証サブエージェント（/api/manual/verify）まわりの純粋関数。
 *
 * node:* も DOM API も使わない。lib/annotation.ts と同じ設計にしてあり、
 * import type しか使わないので `node --test` でバンドラ無しに実行できる。
 */

/** 候補は最大この件数（1回のVLM呼び出しでのトークン増加を抑える） */
const MAX_CANDIDATES = 4;
/** 既存フレーム・他候補とこの秒数未満しか離れていなければ重複とみなす */
const DEDUP_SECONDS = 1;
/**
 * duration の末尾ぎりぎりは PNG が抽出できないことがあるので避ける
 * （lib/manual.ts の mergeFrameTimes と同じ余白の考え方）
 */
const END_MARGIN_SECONDS = 0.05;

export type UtteranceRange = { start: number; end: number };

/**
 * step.time に時刻的に最も近い発話を見つけ、その前後1件ずつ（計最大3発話）の
 * start/end を候補時刻にする。
 *
 * start（言い始めた瞬間＝まだ動作前のことが多い）と end（言い終わった瞬間＝
 * 動作後のことが多い）の両方を候補にすることで、ナレーションの構造的な
 * 半ステップ遅れをカバーする。
 *
 * duration 超過、既存フレームや他候補と1秒未満しか離れていない時刻は除外する
 * （新規に ffmpeg 抽出する意味が無いため）。
 */
export function selectCandidateTimes(
  stepTime: number,
  utterances: UtteranceRange[],
  existingFrameTimes: number[],
  duration: number,
): number[] {
  if (utterances.length === 0) return [];

  let nearestIndex = 0;
  let nearestDist = Infinity;
  utterances.forEach((u, i) => {
    const dist = Math.abs(u.start - stepTime);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestIndex = i;
    }
  });

  const rangeIndices = [nearestIndex - 1, nearestIndex, nearestIndex + 1].filter(
    (i) => i >= 0 && i < utterances.length,
  );

  const raw: number[] = [];
  for (const i of rangeIndices) {
    raw.push(utterances[i].start, utterances[i].end);
  }

  const accepted: number[] = [];
  for (const t of raw) {
    if (!Number.isFinite(t) || t < 0) continue;
    if (duration > 0 && t >= duration - END_MARGIN_SECONDS) continue;
    if (existingFrameTimes.some((e) => Math.abs(e - t) < DEDUP_SECONDS)) continue;
    if (accepted.some((a) => Math.abs(a - t) < DEDUP_SECONDS)) continue;
    accepted.push(t);
  }

  return accepted.slice(0, MAX_CANDIDATES);
}

export type VerificationParseResult =
  | { ok: true; best: number } // 0 = 一致なし、1 = 現在のまま、2以上 = 候補番号
  | { ok: false };

/**
 * モデルの生テキストをパースする。
 * best が整数でない、または候補数の範囲外なら失敗として扱う。
 * 失敗時は呼び出し側が「現状維持」で処理する（誤って画像を差し替えるより安全）。
 */
export function parseVerification(raw: string, candidateCount: number): VerificationParseResult {
  // モデルが ```json フェンスや前置きを付けることがあるのでオブジェクト部分だけ取り出す
  // （lib/llm.ts の mergeManualSteps / lib/annotation.ts と同じ切り出し方）
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false };

  const { best } = parsed as { best?: unknown };
  if (typeof best !== "number" || !Number.isInteger(best)) return { ok: false };
  if (best < 0 || best > candidateCount) return { ok: false };

  return { ok: true, best };
}
