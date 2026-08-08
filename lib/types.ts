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
  /**
   * caption = 映像フレームの説明（time は実在するフレーム PNG の時刻）
   * utterance = 音声の書き起こし（time は発話区間の開始秒で、対応するフレーム PNG は無い）
   */
  source: "caption" | "utterance";
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

/** 操作マニュアルの1手順 */
export type ManualStep = {
  /** 手順を始める時刻(秒)。保存時に抽出済みフレームの時刻へスナップしてある */
  time: number;
  /** 「〜をクリックする」のような、動作が分かる短いタイトル */
  title: string;
  /** 何をするか。音声で理由が語られていれば「なぜそうするのか」も含む */
  description: string;
};

export type ManualStepWithMeta = ManualStep & {
  /** time に対応するフレーム PNG。手順のサムネイルと Markdown の画像に使う */
  imageUrl: string;
};

/**
 * 操作マニュアルの解析結果。
 * AnalysisResult のスーパーセットにしてあるので、/api/search と /api/ask は
 * コードを変えずにそのまま使える（loadAnalysis は JSON.parse の結果を
 * AnalysisResult として扱うだけなので、steps は型から見えないままランタイムには残る）。
 */
export type ManualResult = AnalysisResult & {
  steps: ManualStepWithMeta[];
};

/**
 * /api/manual/analyze が SSE で流すイベント。
 * AnalyzeEvent とは分離してある（info/caption の形が異なり、同じ判別子で違う形の
 * バリアントは union に共存できないため）。
 */
export type ManualAnalyzeEvent =
  | {
      type: "info";
      id: string;
      videoUrl: string;
      duration: number;
      frameCount: number;
      method: FrameMethod;
      utteranceCount: number;
      /** frameCount のうち、発話の開始時刻に由来する枚数 */
      utteranceFrameCount: number;
    }
  | {
      type: "caption";
      index: number;
      time: number;
      text: string;
      imageUrl: string;
      fromUtterance: boolean;
    }
  | { type: "utterances"; utterances: Utterance[] }
  | { type: "summary"; text: string }
  | { type: "steps"; steps: ManualStepWithMeta[] }
  | { type: "done"; id: string }
  | { type: "error"; message: string };
