/**
 * ローカル llama-server 群のクライアント。
 * 各エンドポイントの役割は README.md の「構成」を参照。
 */
import type { Caption, Chapter, ChatTurn, Utterance } from "@/lib/types";

const VLM_ENDPOINT = process.env.VLM_ENDPOINT ?? "http://127.0.0.1:8084";
const LLM_ENDPOINT = process.env.LLM_ENDPOINT ?? "http://127.0.0.1:8080";
const EMBED_ENDPOINT = process.env.EMBED_ENDPOINT ?? "http://127.0.0.1:8082";

type ChatResponse = {
  choices: { message: { content: string | null } }[];
};

async function postJson<T>(url: string, body: unknown, timeoutMs = 300_000): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`${url} が ${res.status} を返しました: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

/** 1フレームを日本語で言語化する。画像1枚あたり約1,050トークン・5〜7秒かかる。 */
export async function captionFrame(pngBase64: string): Promise<string> {
  const body = await postJson<ChatResponse>(`${VLM_ENDPOINT}/v1/chat/completions`, {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "この動画フレームに写っているものを日本語で説明してください。" +
              "画面内の文字や数値は正確に読み取ってください。3文以内で簡潔に。",
          },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${pngBase64}` },
          },
        ],
      },
    ],
    max_tokens: 300,
    temperature: 0.7,
    top_p: 0.8,
  });

  return body.choices[0]?.message.content?.trim() ?? "";
}

/**
 * 8080 の gemma-4-12b にメッセージ列を投げる。
 * このモデルは reasoning モデルなので enable_thinking を切らないと
 * 思考だけで max_tokens を使い切り content が空で返ってくる。
 */
async function chatMessages(messages: ChatTurn[], maxTokens: number): Promise<string> {
  const body = await postJson<ChatResponse>(`${LLM_ENDPOINT}/v1/chat/completions`, {
    messages,
    max_tokens: maxTokens,
    chat_template_kwargs: { enable_thinking: false },
  });

  return body.choices[0]?.message.content?.trim() ?? "";
}

async function chat(prompt: string, maxTokens: number): Promise<string> {
  return chatMessages([{ role: "user", content: prompt }], maxTokens);
}

/** 会話履歴を直近 maxTurns ターン（1ターン=user+assistantの2メッセージ）に切り詰める */
function trimHistory(history: ChatTurn[], maxTurns: number): ChatTurn[] {
  return history.slice(-maxTurns * 2);
}

function formatTimeline(captions: Caption[]): string {
  return captions.map((c) => `[${c.time.toFixed(1)}秒] ${c.text}`).join("\n");
}

function formatUtterances(utterances: Utterance[]): string {
  return utterances
    .map((u) => `[${u.start.toFixed(1)}秒〜${u.end.toFixed(1)}秒] 「${u.text}」`)
    .join("\n");
}

/**
 * 映像の説明と音声の書き起こしをセクションに分けて渡す。
 * 両者は時間粒度が異なる（フレームは数秒おき、発話は文単位）ので時刻でインターリーブせず、
 * 統合判断はモデルに任せる。
 */
function buildContext(captions: Caption[], utterances: Utterance[]): string {
  const sections = [`# 映像の説明\n${formatTimeline(captions)}`];
  if (utterances.length > 0) {
    sections.push(`# 音声の書き起こし\n${formatUtterances(utterances)}`);
  }
  return sections.join("\n\n");
}

/** タイムライン全体を1つの要約文にまとめる。 */
export async function summarize(captions: Caption[], utterances: Utterance[] = []): Promise<string> {
  return chat(
    `以下は動画の映像説明と音声の書き起こしです。全体を1つの要約文章にまとめてください。\n\n${buildContext(captions, utterances)}`,
    600,
  );
}

/** タイムラインを意味のまとまりで章に区切る。失敗時は1フレーム=1章にフォールバックする。 */
export async function splitChapters(captions: Caption[], utterances: Utterance[] = []): Promise<Chapter[]> {
  const raw = await chat(
    `以下は動画の映像説明と音声の書き起こしです。内容のまとまりごとに章に分割してください。\n\n` +
      `${buildContext(captions, utterances)}\n\n` +
      `章タイトルは上の説明に書かれている語句をそのまま使ってください。` +
      `書かれていない数字や固有名詞を推測して補わないでください。\n` +
      `JSON配列だけを出力してください。各要素は {"start": 開始秒(数値), "title": "章タイトル"} です。` +
      `説明文やコードブロックは不要です。`,
    800,
  );

  try {
    // モデルが ```json フェンスや前置きを付けることがあるので配列部分だけ取り出す
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("JSON配列が見つかりません");

    const parsed: unknown = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) throw new Error("配列ではありません");

    const chapters = parsed
      .filter((c): c is Chapter =>
        typeof c === "object" && c !== null &&
        typeof (c as Chapter).start === "number" &&
        typeof (c as Chapter).title === "string")
      .sort((a, b) => a.start - b.start);

    if (chapters.length === 0) throw new Error("有効な章がありません");
    return chapters;
  } catch {
    return captions.map((c) => ({ start: c.time, title: c.text.slice(0, 30) }));
  }
}

/** シーン説明のテキストだけでは答えられないとき、gemma にこの合図を出させる */
export const NEED_IMAGE_SENTINEL = "NEED_IMAGE";

export function needsImageEscalation(answer: string): boolean {
  return answer.trim().length === 0 || answer.includes(NEED_IMAGE_SENTINEL);
}

/**
 * シーン説明のテキストだけを根拠に質問に答える。
 * 色・画面内の文字・表情など説明文に書かれていない細部を聞かれた場合は、
 * 推測せず NEED_IMAGE_SENTINEL を返すよう指示する（フレーム画像へのエスカレーション判定に使う）。
 */
export async function answerFromCaptions(
  question: string,
  context: Caption[],
  history: ChatTurn[],
): Promise<string> {
  const prompt =
    `以下は動画の各シーンの説明です。\n\n${formatTimeline(context)}\n\n` +
    `質問: ${question}\n\n` +
    `これらの説明だけで質問に答えられる場合は、日本語で簡潔に回答してください。` +
    `説明に書かれていない細部（色、画面内の文字、表情、細かい動作など）を問われていて` +
    `説明文からは判断できない場合は、推測せずに「${NEED_IMAGE_SENTINEL}」とだけ出力してください。`;

  return chatMessages([...trimHistory(history, 3), { role: "user", content: prompt }], 400);
}

export type FrameInput = { time: number; base64: string };

/** 関連フレーム画像を Qwen3-VL に見せ直して質問に答える。 */
export async function answerFromFrames(
  question: string,
  frames: FrameInput[],
  history: ChatTurn[],
): Promise<string> {
  const timeLabels = frames.map((f, i) => `${i + 1}枚目: ${f.time.toFixed(1)}秒`).join(" / ");

  const body = await postJson<ChatResponse>(`${VLM_ENDPOINT}/v1/chat/completions`, {
    messages: [
      ...trimHistory(history, 3),
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `${timeLabels} のフレームです。日本語で簡潔に回答してください。\n質問: ${question}`,
          },
          ...frames.map((f) => ({
            type: "image_url" as const,
            image_url: { url: `data:image/png;base64,${f.base64}` },
          })),
        ],
      },
    ],
    max_tokens: 300,
    temperature: 0.7,
    top_p: 0.8,
  });

  return body.choices[0]?.message.content?.trim() ?? "";
}

/** bge-m3 でテキストをベクトル化する。検索用。 */
export async function embed(texts: string[]): Promise<number[][]> {
  const body = await postJson<{ data: { embedding: number[] }[] }>(
    `${EMBED_ENDPOINT}/v1/embeddings`,
    { input: texts },
  );
  return body.data.map((d) => d.embedding);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
