/**
 * ローカル llama-server 群のクライアント。
 * 各エンドポイントの役割は README.md の「構成」を参照。
 */
import type { Caption, Chapter, ChatTurn, ManualStep, Utterance } from "@/lib/types";

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
 * PC操作画面のフレームを、操作マニュアルの素材として言語化する。
 * captionFrame との違いは、「何が写っているか」ではなく「どこに何の操作要素があるか」を
 * 具体名で書かせる点。ボタン名やメニュー項目名はそのまま手順書に載るので、
 * 画面に出ている文字列を正確に書き写させることを最優先にしている。
 */
export async function captionOperationFrame(pngBase64: string): Promise<string> {
  const body = await postJson<ChatResponse>(`${VLM_ENDPOINT}/v1/chat/completions`, {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "これはPCの操作画面を録画した動画の1フレームです。操作マニュアルを作る材料として、日本語で説明してください。\n" +
              "次の順に書いてください。\n" +
              "1. どのアプリケーション・どの画面か（ウィンドウのタイトルやタブ名があれば、そのまま書き写す）\n" +
              "2. 画面に出ている操作要素（メニュー、ボタン、入力欄、チェックボックス、ダイアログ、エラー表示）の名前と位置\n" +
              "3. マウスカーソル・選択枠・ハイライトがあれば、その位置と対象の名前\n" +
              "4. 入力欄に文字が入っていれば、その文字列\n" +
              "ボタン名・メニュー項目名・入力値は、画面に表示されているとおりに「」で囲んで正確に書き写してください。\n" +
              "画面から読み取れないことは推測しないでください。4文以内で。",
          },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${pngBase64}` },
          },
        ],
      },
    ],
    max_tokens: 400,
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

/**
 * 映像の説明と音声の書き起こしから、操作手順の列を作る。
 * 発話は操作者本人の説明なので「何を・なぜ」の主根拠にし、映像は音声では言っていない
 * ボタン名・入力値を補う材料として使わせる。失敗時は splitChapters と同じ考え方で
 * 1フレーム=1手順にフォールバックする。
 */
export async function generateManualSteps(
  captions: Caption[],
  utterances: Utterance[] = [],
): Promise<ManualStep[]> {
  const raw = await chat(
    `以下は、PCの操作画面を録画しながら、操作者がその操作の意味を音声で説明している動画の解析結果です。\n\n` +
      `${buildContext(captions, utterances)}\n\n` +
      `この動画から操作マニュアル（手順書）を作ります。上から順に実行できる手順に分割してください。\n` +
      `「音声の書き起こし」は操作者本人の説明です。何をしているか、なぜそうするのかは必ずこちらを根拠にしてください。\n` +
      `「映像の説明」は各時刻に画面へ表示されていたものです。音声では言っていないボタン名・メニュー名・入力値を補うために使ってください。\n` +
      `title は「〜をクリックする」のように動作が分かる短い命令形（30文字以内）にしてください。\n` +
      `description は1〜3文で、何をするかに加えて、音声で理由が語られていればそれも書いてください。\n` +
      `画面上の名前は上の説明に書かれているとおりに書き写し、書かれていない名前や数値を推測して補わないでください。\n` +
      `挨拶や雑談だけの区間は手順にしないでください。\n` +
      `JSON配列だけを出力してください。各要素は ` +
      `{"time": 開始秒(数値), "title": "手順のタイトル", "description": "手順の説明"} です。` +
      `説明文やコードブロックは不要です。`,
    2000,
  );

  try {
    // モデルが ```json フェンスや前置きを付けることがあるので配列部分だけ取り出す
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("JSON配列が見つかりません");

    const parsed: unknown = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) throw new Error("配列ではありません");

    const steps = parsed
      .filter((s): s is ManualStep =>
        typeof s === "object" && s !== null &&
        typeof (s as ManualStep).time === "number" &&
        typeof (s as ManualStep).title === "string" &&
        typeof (s as ManualStep).description === "string")
      .map((s) => ({ time: s.time, title: s.title.trim(), description: s.description.trim() }))
      .filter((s) => s.title.length > 0)
      .sort((a, b) => a.time - b.time);

    if (steps.length === 0) throw new Error("有効な手順がありません");
    return steps;
  } catch {
    return captions.map((c) => ({
      time: c.time,
      title: c.text.slice(0, 30),
      description: c.text,
    }));
  }
}

/**
 * 同じフレームにスナップされた複数の手順を、1つの手順に合成する。
 * 1画面で続けて行う入力操作を別々の手順として並べると、同じスクリーンショットが
 * 何枚も続く読みにくい手順書になるため、後処理として文章ごとまとめる。
 * 機械的に連結するのではなくモデルに書き直させるのは、「〜を入力します」の羅列を
 * 1つの自然な文にするため。
 *
 * generateManualSteps と同じく、パースに失敗したら機械的な連結にフォールバックする
 * （合成できなくても、元の手順の情報は落とさない）。
 */
export async function mergeManualSteps(
  steps: ManualStep[],
): Promise<Pick<ManualStep, "title" | "description">> {
  const list = steps.map((s, i) => `${i + 1}. ${s.title}\n   ${s.description}`).join("\n");

  const raw = await chat(
    `以下は、PCの操作画面を録画した動画から自動生成した操作手順です。` +
      `すべて同じ画面（同じスクリーンショット）に対する操作なので、1つの手順にまとめてください。\n\n` +
      `${list}\n\n` +
      `title は、この画面でまとめて行う操作が分かる短い命令形（30文字以内）にしてください。` +
      `必ず「〜する」で終わる形にし、体言止めにはしないでください。\n` +
      `description は1〜4文で、上の手順を書かれている順につないだ自然な文章にしてください。` +
      `箇条書きにはしないでください。\n` +
      `上の手順に書かれている画面上の名前や数値だけを使い、` +
      `書かれていない名前や数値を推測して補わないでください。\n` +
      `上の手順のどれも省略しないでください。注意や確認だけの項目も残してください。\n` +
      `JSONオブジェクトだけを出力してください。形式は ` +
      `{"title": "手順のタイトル", "description": "手順の説明"} です。` +
      `説明文やコードブロックは不要です。`,
    300,
  );

  try {
    // モデルが```jsonフェンスや前置きを付けることがあるのでオブジェクト部分だけ取り出す
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("JSONオブジェクトが見つかりません");

    const parsed: unknown = JSON.parse(match[0]);
    if (typeof parsed !== "object" || parsed === null) throw new Error("オブジェクトではありません");

    const { title, description } = parsed as Partial<ManualStep>;
    if (typeof title !== "string" || typeof description !== "string") {
      throw new Error("title / description がありません");
    }
    if (title.trim().length === 0) throw new Error("title が空です");

    return { title: title.trim(), description: description.trim() };
  } catch {
    return concatManualSteps(steps);
  }
}

/** 合成に失敗したときの機械的な連結。情報は落とさないが読みやすさは諦める */
function concatManualSteps(steps: ManualStep[]): Pick<ManualStep, "title" | "description"> {
  return {
    title: steps.map((s) => s.title).join("、"),
    description: steps.map((s) => s.description).join(" "),
  };
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

/**
 * スクリーンショット注釈サブエージェント。
 *
 * captionOperationFrame が「画面に何があるか」を書かせるのに対し、これは
 * 「この手順で触る要素はどれか」だけを選ばせる。役割・入出力契約・失敗の扱いを
 * 他の VLM 呼び出しから切り離してあるので、プロンプトを変えても
 * 既存の解析パイプラインには一切影響しない。
 *
 * temperature を既存の 0.7 ではなく 0.1 にしているのは、これが創作ではなく
 * 位置の同定（グラウンディング）だから。同じ画面には同じ答えが返ってほしい。
 *
 * 戻り値は生のモデル出力（未パース）。妥当性検証は lib/annotation.ts の
 * parseStepAnnotation が担う（サブエージェントは受け取った答えをそのまま返すだけで、
 * 「信じてよいか」の判断は呼び出し側の責務にする）。
 */
export async function annotateStepTarget(input: {
  pngBase64: string;
  title: string;
  description: string;
  /** 同じ時刻の captionOperationFrame の結果。画面上の要素名の裏取りに使う */
  caption?: string;
  timeoutMs?: number;
}): Promise<string> {
  const { pngBase64, title, description, caption, timeoutMs } = input;

  const captionLine = caption ? `この画面の説明（別の解析結果）: ${caption}\n` : "";

  const body = await postJson<ChatResponse>(
    `${VLM_ENDPOINT}/v1/chat/completions`,
    {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "これはPC操作マニュアルの1手順に対応するスクリーンショットです。\n" +
                "この手順で操作する対象のUI要素を画面から特定し、位置を返してください。\n\n" +
                `手順のタイトル: 「${title}」\n` +
                `手順の説明: 「${description}」\n` +
                captionLine +
                "\n規則:\n" +
                "- 座標は、画像の左上を [0,0]、右下を [1000,1000] とする正規化座標で答えてください。\n" +
                "  bbox_2d は [左, 上, 右, 下] の順の整数4つです。\n" +
                "  画像の実際のピクセル数（幅や高さ）は使わないでください。必ず0〜1000の範囲です。\n" +
                "- 枠は操作要素そのもの（ボタン1つ、入力欄1つ、メニュー項目1つ、チェックボックス1つ）に\n" +
                "  ぴったり合わせてください。ウィンドウ全体・パネル全体・画面の広い領域は囲まないでください。\n" +
                "- label には、その要素に表示されている文字をそのまま書き写してください。\n" +
                "  画面に無い文字を作らないでください。文字が無い要素は label を \"\" にしてください。\n" +
                "- 同じ画面で複数の操作を続けて行う手順のときだけ、操作する順番に最大4個まで並べてください。\n" +
                "  1つで足りるときは1個だけにしてください。\n" +
                "- 手順に書かれている要素が画面に見当たらないとき（タイトル画面、説明スライド、\n" +
                "  デスクトップ、その要素が別の画面にある、など）は、必ず\n" +
                '  {"found": false, "targets": []} と答えてください。\n' +
                "  近そうな別の要素で代用しないでください。見当たらないと答えるのは正しい答えです。\n\n" +
                "JSONオブジェクトだけを出力してください。形式は\n" +
                '{"found": true, "targets": [{"label": "要素の文字", "kind": "button", "bbox_2d": [120, 640, 210, 668]}]}\n' +
                "です（この数値は形式の例であり、実際の位置とは無関係です）。\n" +
                "kind は button / input / dropdown / checkbox / menu / tab / link / other のいずれかです。\n" +
                "説明文やコードブロックは不要です。",
            },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${pngBase64}` },
            },
          ],
        },
      ],
      max_tokens: 300,
      temperature: 0.1,
      top_p: 0.9,
    },
    timeoutMs ?? 90_000,
  );

  return body.choices[0]?.message.content?.trim() ?? "";
}

/**
 * スクリーンショット検証サブエージェント。
 *
 * 「現在この手順に使われている画像」と「動画から新たに抽出した候補」をまとめて
 * 1回の呼び出しで見せ、最も説明に合うものを選ばせる。検証（不一致か）と
 * 選択（どれに差し替えるか）を1回のVLM呼び出しに統合することで、
 * 手順数×候補数の呼び出し爆発を避ける（answerFromFrames と同じ複数画像パターン）。
 *
 * annotateStepTarget と同じく低temperature（構造化判定タスクのため）。
 */
export async function verifyStepScreenshot(input: {
  title: string;
  description: string;
  /** 1枚目=現在の画像、2枚目以降=新規候補。time はラベル表示にだけ使う */
  candidates: { time: number; base64: string }[];
  timeoutMs?: number;
}): Promise<string> {
  const { title, description, candidates, timeoutMs } = input;
  const labels = candidates
    .map((c, i) => `${i + 1}枚目（${i === 0 ? "現在使われている画像" : "候補"}・${c.time.toFixed(1)}秒）`)
    .join(" / ");

  const body = await postJson<ChatResponse>(
    `${VLM_ENDPOINT}/v1/chat/completions`,
    {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "これはPC操作マニュアルの1手順に対応するスクリーンショット候補です。\n" +
                `手順のタイトル: 「${title}」\n` +
                `手順の説明: 「${description}」\n\n` +
                `${labels} の画像です。\n\n` +
                "この説明文の内容が実際に写っている（またはこれから起きようとしている）画像はどれですか。\n" +
                "最も説明に合う画像の番号を1つ選んでください。1枚目（現在の画像）が最も適切であれば1と答えてください。\n" +
                "どの画像も説明に合わない場合は 0 と答えてください。近そうな画像で妥協しないでください。\n\n" +
                'JSONオブジェクトだけを出力してください: {"best": 番号}\n' +
                "説明文やコードブロックは不要です。",
            },
            ...candidates.map((c) => ({
              type: "image_url" as const,
              image_url: { url: `data:image/png;base64,${c.base64}` },
            })),
          ],
        },
      ],
      max_tokens: 100,
      temperature: 0.1,
      top_p: 0.9,
    },
    timeoutMs ?? 90_000,
  );

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
