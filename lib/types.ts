/** サーバとクライアントで共有する型定義 */

export type Caption = { time: number; text: string };

export type Chapter = { start: number; title: string };

export type CaptionWithMeta = Caption & {
  imageUrl: string;
  /** bge-m3 によるベクトル。検索時にクエリとのコサイン類似度を取る */
  embedding: number[];
};

/** フレームの選び方。scene = シーン検出 / interval = 等間隔へのフォールバック */
export type FrameMethod = "scene" | "interval";

/** whisper.cpp による音声の書き起こし1セグメント */
export type Utterance = { start: number; end: number; text: string };

export type UtteranceWithMeta = Utterance & {
  /** bge-m3 によるベクトル。検索時にクエリとのコサイン類似度を取る */
  embedding: number[];
};

export type AnalysisResult = {
  id: string;
  videoUrl: string;
  duration: number;
  method: FrameMethod;
  summary: string;
  chapters: Chapter[];
  captions: CaptionWithMeta[];
  /** 音声トラックが無い、または文字起こしが無効な動画では空配列 */
  utterances: UtteranceWithMeta[];
};

/** /api/analyze が SSE で流すイベント */
export type AnalyzeEvent =
  | {
      type: "info";
      id: string;
      videoUrl: string;
      duration: number;
      frameCount: number;
      method: FrameMethod;
    }
  | { type: "caption"; index: number; time: number; text: string; imageUrl: string }
  | { type: "utterances"; utterances: Utterance[] }
  | { type: "summary"; text: string }
  | { type: "chapters"; chapters: Chapter[] }
  | { type: "done"; id: string }
  | { type: "error"; message: string };

/** /api/search のレスポンス */
export type SearchHit = {
  time: number;
  text: string;
  /** 音声由来のヒットには画像が無い */
  imageUrl?: string;
  score: number;
};

/** /api/ask に送る会話履歴の1ターン */
export type ChatTurn = { role: "user" | "assistant"; content: string };

/** 回答がテキストのみで生成されたか、フレーム画像を見直して生成されたか */
export type AskSource = "llm" | "vlm";

export type AskCitation = { time: number; text: string };

/** /api/ask のレスポンス */
export type AskResponse = {
  answer: string;
  source: AskSource;
  citations: AskCitation[];
};
