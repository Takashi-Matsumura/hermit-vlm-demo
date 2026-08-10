/**
 * 意図駆動モード（/api/manual/narrated/analyze）まわりの純粋関数。
 *
 * node:* も DOM API も使わない。lib/annotation.ts / lib/verification.ts と同じ設計にしてあり、
 * import type しか使わないので `node --test` でバンドラ無しに実行できる。
 *
 * 設計の要点（ローカルの gemma-4-12b に実データを投げて検証した結果に基づく）:
 * - 発話の参照は時刻ではなく添字（0..utterances.length-1）で持つ。添字は有限集合と
 *   照合できるので範囲外・重複を機械的に検出できるが、時刻は「もっともらしい値」を
 *   モデルが生成しても検証できない（README の「発話の51%が対応フレーム無し」と同じ
 *   構造的問題の再発を避けるため）。
 * - 発話数百件を一度に要約させると、LLM は後半を静かに無視する（実測: 400件を一括投入
 *   すると被覆21%）。90件程度のチャンクに分割すれば被覆100%になったが、この閾値は
 *   コンテキスト長の問題ではない（gemma の n_ctx は262k/スロットで余裕がある）。
 *   モデルの「まとめ漏れ」なので coverageRatio で機械的に検出しゲートする。
 * - 時間範囲（from/to）の算術は LLM にやらせない（実測: 重複・非単調な範囲
 *   （例: "9-150" と "20-99" が併存）を返した）。LLM には「どの局所項目をまとめるか」
 *   だけを決めさせ、範囲の計算は normalizeOutlineGroups がここで行う。
 */
import type { Caution, PlannedStep, Utterance } from "@/lib/types";

export type UtteranceChunkRange = { from: number; to: number };

/**
 * 発話の添字レンジをチャンクに分割する。グローバルな添字のまま返すので
 * （チャンクごとに0から採番し直さない）、モデルへの指示もパース後の検証も
 * 単純になる。
 *
 * overlap は隣接チャンクの境界で話題が分断されるのを防ぐための重なり幅。
 * count が maxPerChunk 以下なら1チャンクにまとめる。
 */
export function chunkUtterances(
  count: number,
  options: { maxPerChunk: number; overlap: number },
): UtteranceChunkRange[] {
  if (count <= 0) return [];
  const { maxPerChunk, overlap } = options;
  if (count <= maxPerChunk) return [{ from: 0, to: count - 1 }];

  // overlap が maxPerChunk 以上だと無限ループになるので、最低1つは前進させる
  const step = Math.max(1, maxPerChunk - overlap);
  const chunks: UtteranceChunkRange[] = [];
  let from = 0;
  while (from < count) {
    const to = Math.min(from + maxPerChunk - 1, count - 1);
    chunks.push({ from, to });
    if (to === count - 1) break;
    from += step;
  }
  return chunks;
}

/**
 * 発話をモデルに渡すテキストに整形する。"[n] テキスト" の形式で、時刻は含めない。
 * 時刻を渡すとモデルが time を出力したがる（実測でプロンプトも肥大化した）ため、
 * 添字だけを渡し、範囲の算術は一切モデルにやらせない設計にしている。
 */
export function formatUtteranceLines(utterances: Utterance[], range: UtteranceChunkRange): string {
  const lines: string[] = [];
  for (let i = range.from; i <= range.to && i < utterances.length; i++) {
    lines.push(`[${i}] ${utterances[i].text}`);
  }
  return lines.join("\n");
}

function isValidIndexRange(r: { from: number; to: number }, bounds: UtteranceChunkRange): boolean {
  return (
    Number.isInteger(r.from) &&
    Number.isInteger(r.to) &&
    r.from <= r.to &&
    r.from >= bounds.from &&
    r.to <= bounds.to
  );
}

export type OutlineChunkResult =
  | { ok: true; items: PlannedStep[]; cautions: Caution[] }
  | { ok: false };

/**
 * map フェーズ（outlineUtteranceChunk）の生テキストをパースする。
 * from/to が整数でない、range の外を指す、from > to のいずれかであれば
 * その要素だけを除去する（1件の不正でチャンク全体を捨てない）。
 * 有効な要素が1つも無ければ失敗として扱い、呼び出し側の決定論的フォールバックに委ねる。
 */
export function parseOutlineChunk(raw: string, range: UtteranceChunkRange): OutlineChunkResult {
  // モデルが ```json フェンスや前置きを付けることがあるのでオブジェクト部分だけ取り出す
  // （lib/llm.ts の mergeManualSteps / lib/verification.ts と同じ切り出し方）
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false };

  const { outline, cautions } = parsed as { outline?: unknown; cautions?: unknown };
  if (!Array.isArray(outline)) return { ok: false };

  const items = outline
    .map((o) => (typeof o === "object" && o !== null ? (o as Record<string, unknown>) : null))
    .filter((o): o is Record<string, unknown> => o !== null)
    .filter((o) => typeof o.title === "string" && typeof o.intent === "string" && typeof o.from === "number" && typeof o.to === "number")
    .map((o) => ({
      title: (o.title as string).trim(),
      intent: (o.intent as string).trim(),
      from: o.from as number,
      to: o.to as number,
    }))
    .filter((o) => o.title.length > 0 && isValidIndexRange(o, range))
    .sort((a, b) => a.from - b.from);

  if (items.length === 0) return { ok: false };

  const cautionList = Array.isArray(cautions)
    ? cautions
        .map((c) => (typeof c === "object" && c !== null ? (c as Record<string, unknown>) : null))
        .filter((c): c is Record<string, unknown> => c !== null)
        .filter((c) => typeof c.text === "string" && typeof c.from === "number" && typeof c.to === "number")
        .map((c) => ({ text: (c.text as string).trim(), from: c.from as number, to: c.to as number }))
        .filter((c) => c.text.length > 0 && isValidIndexRange(c, range))
        .sort((a, b) => a.from - b.from)
    : [];

  return { ok: true, items, cautions: cautionList };
}

export type OutlineReduceGroup = { title: string; intent: string; members: number[] };
export type OutlineReduceHeader = { title: string; audience: string; goal: string; prerequisites: string[] };
export type OutlineReduceResult =
  | { ok: true; header: OutlineReduceHeader; groups: OutlineReduceGroup[] }
  | { ok: false };

/**
 * reduce フェーズ（reduceManualOutline）の生テキストをパースする。
 * このパースは from/to を一切扱わない（members = 局所アウトライン項目の添字のみ）。
 * 範囲の算術はモデルにやらせず normalizeOutlineGroups が行う、という設計の要。
 *
 * members は 0..localCount-1 の範囲外・非整数を除去し、同一グループ内の重複はまとめる。
 * title が空、または有効な members が1件も無いグループは丸ごと除去する。
 */
export function parseOutlineReduce(raw: string, localCount: number): OutlineReduceResult {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false };

  const { title, audience, goal, prerequisites, groups } = parsed as {
    title?: unknown;
    audience?: unknown;
    goal?: unknown;
    prerequisites?: unknown;
    groups?: unknown;
  };
  if (typeof title !== "string" || title.trim().length === 0) return { ok: false };
  if (!Array.isArray(groups)) return { ok: false };

  const validGroups = groups
    .map((g) => (typeof g === "object" && g !== null ? (g as Record<string, unknown>) : null))
    .filter((g): g is Record<string, unknown> => g !== null)
    .map((g) => {
      const memberIds = Array.isArray(g.members)
        ? g.members.filter((m): m is number => typeof m === "number" && Number.isInteger(m) && m >= 0 && m < localCount)
        : [];
      return {
        title: typeof g.title === "string" ? g.title.trim() : "",
        intent: typeof g.intent === "string" ? g.intent.trim() : "",
        members: Array.from(new Set(memberIds)),
      };
    })
    .filter((g) => g.title.length > 0 && g.members.length > 0);

  if (validGroups.length === 0) return { ok: false };

  return {
    ok: true,
    header: {
      title: title.trim(),
      audience: typeof audience === "string" ? audience.trim() : "",
      goal: typeof goal === "string" ? goal.trim() : "",
      prerequisites: Array.isArray(prerequisites)
        ? prerequisites.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim())
        : [],
    },
    groups: validGroups,
  };
}

/** 昇順ソート済みの一意な添字列を、連続するランごとに分割する（[3,7] → [[3],[7]]） */
function splitIntoRuns(sortedIds: number[]): number[][] {
  const runs: number[][] = [];
  let current: number[] = [];
  for (const id of sortedIds) {
    if (current.length === 0 || id === current[current.length - 1] + 1) {
      current.push(id);
    } else {
      runs.push(current);
      current = [id];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * reduce フェーズが返したグループ（members = 局所アウトライン項目の添字）を、
 * 実際の発話添字範囲を持つ PlannedStep に変換する。
 *
 * 2つの実測した失敗パターンに対する防波堤:
 * 1. members が非連続（例: [3,7]）— モデルは「まとめる」つもりでも、実際には
 *    間の項目（4,5,6）を無視している。連続ランごとに別項目へ分割する。
 * 2. 複数グループが重複する範囲を作る（例: "9-150" と "20-99"）— from/to を
 *    直接モデルに書かせていた頃の不具合。members 方式でも、同じ局所項目が
 *    複数グループに属す可能性は残るため、最後に包含関係で重複を除去する。
 */
export function normalizeOutlineGroups(groups: OutlineReduceGroup[], locals: PlannedStep[]): PlannedStep[] {
  const produced: PlannedStep[] = [];

  for (const group of groups) {
    const sortedIds = [...group.members].filter((id) => id >= 0 && id < locals.length).sort((a, b) => a - b);
    for (const run of splitIntoRuns(sortedIds)) {
      const froms = run.map((id) => locals[id].from);
      const tos = run.map((id) => locals[id].to);
      produced.push({
        title: group.title,
        intent: group.intent,
        from: Math.min(...froms),
        to: Math.max(...tos),
      });
    }
  }

  produced.sort((a, b) => a.from - b.from || a.to - b.to);

  // 前に採用した項目に完全に包含される項目は重複とみなして捨てる
  const deduped: PlannedStep[] = [];
  for (const item of produced) {
    const containedInPrevious = deduped.some((kept) => item.from >= kept.from && item.to <= kept.to);
    if (!containedInPrevious) deduped.push(item);
  }
  return deduped;
}

/**
 * アウトライン項目が発話全体をどれだけ被覆しているかを返す（0〜1）。
 * 実測で発話400件の一括投入時に0.21まで落ち込んだ。この数値を品質ゲートとして使う。
 */
export function coverageRatio(items: PlannedStep[], utteranceCount: number): number {
  if (utteranceCount <= 0) return 0;
  const covered = new Set<number>();
  for (const item of items) {
    const from = Math.max(0, item.from);
    const to = Math.min(utteranceCount - 1, item.to);
    for (let i = from; i <= to; i++) covered.add(i);
  }
  return covered.size / utteranceCount;
}

/**
 * 被覆されていない連続区間（minGap 発話以上のもの）を、汎用タイトルの項目として補う。
 * ここでは発話本文を受け取らないので、内容の分かるタイトルは付けられない
 * （「誤った内容を捏造するくらいなら空白のまま示す」という README の方針に合わせている）。
 */
export function repairOutlineGaps(items: PlannedStep[], utteranceCount: number, minGap: number): PlannedStep[] {
  const covered = new Array<boolean>(utteranceCount).fill(false);
  for (const item of items) {
    const from = Math.max(0, item.from);
    const to = Math.min(utteranceCount - 1, item.to);
    for (let i = from; i <= to; i++) covered[i] = true;
  }

  const gaps: UtteranceChunkRange[] = [];
  let start: number | null = null;
  for (let i = 0; i < utteranceCount; i++) {
    if (!covered[i]) {
      if (start === null) start = i;
    } else if (start !== null) {
      gaps.push({ from: start, to: i - 1 });
      start = null;
    }
  }
  if (start !== null) gaps.push({ from: start, to: utteranceCount - 1 });

  const repaired: PlannedStep[] = gaps
    .filter((g) => g.to - g.from + 1 >= minGap)
    .map((g) => ({
      title: `（未分類の発話 ${g.from}〜${g.to}）`,
      intent: "",
      from: g.from,
      to: g.to,
    }));

  return [...items, ...repaired].sort((a, b) => a.from - b.from);
}

export type TimeSpan = { start: number; end: number };

/**
 * 発話添字レンジを実際の時間範囲に変換する。
 * duration の末尾ぎりぎりは PNG が抽出できないことがあるので避ける
 * （lib/manual.ts の mergeFrameTimes、lib/verification.ts の END_MARGIN_SECONDS と同じ余白）。
 */
export function utteranceRangeToTimeSpan(range: UtteranceChunkRange, utterances: Utterance[], duration: number): TimeSpan {
  if (utterances.length === 0) return { start: 0, end: 0 };

  const from = Math.max(0, Math.min(range.from, utterances.length - 1));
  const to = Math.max(from, Math.min(range.to, utterances.length - 1));

  const start = utterances[from].start;
  let end = utterances[to].end;
  if (duration > 0) end = Math.min(end, duration - 0.05);
  if (end < start) end = start;

  return { start, end };
}

/**
 * 1手順ぶんの候補フレーム時刻を選ぶ。span の開始・終端（間があれば中間点も）を
 * perStep 件、既存フレーム・互いの時刻から minGap 未満のものは間引く。
 * 時刻は3桁に丸めた値を唯一の正とする（lib/manual.ts の mergeFrameTimes と同じ規約）。
 */
export function selectPlannedFrameTimes(
  span: TimeSpan,
  options: { duration: number; perStep: number; minGap: number; existing: number[] },
): number[] {
  const { duration, perStep, minGap, existing } = options;
  const { start, end } = span;
  const count = Math.max(1, perStep);

  const raw =
    count === 1
      ? [(start + end) / 2]
      : Array.from({ length: count }, (_, i) => start + ((end - start) * i) / (count - 1));

  const maxTime = duration > 0 ? duration - 0.05 : Infinity;
  const rounded = raw
    .map((t) => Number(Math.max(0, Math.min(t, maxTime)).toFixed(3)))
    .filter((t) => Number.isFinite(t));

  const accepted: number[] = [];
  for (const t of rounded) {
    if (existing.some((e) => Math.abs(e - t) < minGap)) continue;
    if (accepted.some((a) => Math.abs(a - t) < minGap)) continue;
    accepted.push(t);
  }
  return accepted;
}

/**
 * 近似同一の注意事項を統合する。テキストの完全一致（前後空白除去後）でのみ重複と判定し、
 * 表記ゆれの吸収はしない（誤って別の注意事項を統合する方が、統合し損ねるより危険なため）。
 * 統合時は最も早い範囲を残す。範囲を union しない（README「誤った枠を描くくらいなら
 * 描かない」と同じく、根拠の無い拡張はしない）。
 */
export function dedupeCautions(cautions: Caution[]): Caution[] {
  const byText = new Map<string, Caution>();
  for (const c of cautions) {
    const key = c.text.trim();
    const kept = byText.get(key);
    if (!kept || c.from < kept.from || (c.from === kept.from && c.to < kept.to)) {
      byText.set(key, c);
    }
  }
  return Array.from(byText.values()).sort((a, b) => a.from - b.from);
}

export type CautionAssignment = { stepCautions: Caution[][]; documentCautions: Caution[] };

/**
 * 注意事項を、根拠発話が範囲に含まれる手順に紐づける。どの手順の範囲にも
 * 含まれない注意事項は文書レベル（ManualIntent.cautions）に残す。
 * stepCautions は planned と同じ長さ・同じ添字で対応する。
 */
export function assignCautionsToSteps(cautions: Caution[], planned: PlannedStep[]): CautionAssignment {
  const stepCautions: Caution[][] = planned.map(() => []);
  const documentCautions: Caution[] = [];

  for (const c of cautions) {
    const index = planned.findIndex((p) => c.from >= p.from && c.from <= p.to);
    if (index >= 0) stepCautions[index].push(c);
    else documentCautions.push(c);
  }

  return { stepCautions, documentCautions };
}
