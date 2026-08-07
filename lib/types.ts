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

export type AnalysisResult = {
  id: string;
  videoUrl: string;
  duration: number;
  method: FrameMethod;
  summary: string;
  chapters: Chapter[];
  captions: CaptionWithMeta[];
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
  | { type: "summary"; text: string }
  | { type: "chapters"; chapters: Chapter[] }
  | { type: "done"; id: string }
  | { type: "error"; message: string };

/** /api/search のレスポンス */
export type SearchHit = {
  time: number;
  text: string;
  imageUrl: string;
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
