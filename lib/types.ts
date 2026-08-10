/** サーバとクライアントで共有する型定義 */

export type Caption = { time: number; text: string };

export type Chapter = { start: number; title: string };

export type CaptionWithMeta = Caption & {
  imageUrl: string;
  /** bge-m3 によるベクトル。検索時にクエリとのコサイン類似度を取る */
  embedding: number[];
};

/**
 * フレームの選び方。scene = シーン検出 / interval = 等間隔へのフォールバック /
 * planned = 意図駆動モードで手順の根拠区間から選んだもの（/api/manual/narrated/analyze）
 */
export type FrameMethod = "scene" | "interval" | "planned";

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

/**
 * 正規化バウンディングボックス。画像の左上を [0,0]、右下を [1000,1000] とする。
 * Qwen3-VL がこの座標系で返すので、ピクセルに直さずこのまま保存する
 * （フレーム PNG を別解像度で作り直しても注釈が壊れない）。
 */
export type NormalizedBox = { x1: number; y1: number; x2: number; y2: number };

/** 画像内の実ピクセル矩形。ffmpeg の crop=W:H:X:Y にそのまま対応する */
export type PixelRect = { x: number; y: number; width: number; height: number };

/** 注釈サブエージェントが特定した、手順で操作する対象1件 */
export type AnnotationTarget = {
  /** その要素に表示されている文字（「印刷」など）。文字が無い要素では空文字 */
  label: string;
  /** button / input / dropdown / checkbox / menu / tab / link / other */
  kind: string;
  box: NormalizedBox;
  /**
   * crop-and-zoom の何周目で確定したか（1〜3）。省略時は旧データ
   * （3周ループ導入前に1回の呼び出しだけで確定した注釈）を意味する。
   */
  refinedAtRound?: number;
};

/** スクリーンショット注釈サブエージェントの出力。1手順ぶん */
export type StepAnnotation = {
  /** 操作する順に並んだ対象。1〜4件。バッジの番号は配列の添字+1 */
  targets: AnnotationTarget[];
  /** 注釈を作ったときのフレーム PNG の実寸。SVG の viewBox と線の太さの計算に使う */
  frameWidth: number;
  frameHeight: number;
};

/** スクリーンショット検証サブエージェント（/api/manual/verify）が1手順に下した判定 */
export type StepVerification = {
  /** 最終的に採用された画像が説明と一致していたか */
  matches: boolean;
  /** 3回のループでも一致する画像が見つからなかった場合 true。UIで「要確認」表示に使う */
  needsReview: boolean;
  /** 何周目で確定したか（1〜3） */
  resolvedAtRound: number;
};

export type ManualStepWithMeta = ManualStep & {
  /** time に対応するフレーム PNG。手順のサムネイルと Markdown の画像に使う */
  imageUrl: string;
  /**
   * 注釈サブエージェント（/api/manual/annotate）の結果。
   * 未実行・対象なし・妥当性検証で棄却、のいずれでも undefined になる。
   * 任意プロパティにしてあるので、注釈が無い既存の result.json はそのまま読める。
   */
  annotation?: StepAnnotation;
  /**
   * スクリーンショット検証サブエージェント（/api/manual/verify）の結果。
   * 未実行なら undefined。任意プロパティなので既存 result.json はそのまま読める。
   */
  verification?: StepVerification;
  /**
   * 意図駆動モード（/api/manual/narrated/analyze）のみ。この手順の根拠になった
   * 発話の添字範囲（result.utterances の添字、閉区間）。時刻ではなく添字で持つのは、
   * 添字は 0..utterances.length-1 という有限集合と照合できるため
   * （lib/intent.ts の設計方針を参照）。
   */
  sourceUtterances?: { from: number; to: number };
  /** 意図駆動モードのみ。この手順に紐づく注意事項。紐づかないものは ManualIntent.cautions へ */
  cautions?: Caution[];
};

/** 意図駆動モードで抽出した注意事項。根拠は発話の添字（時刻ではない） */
export type Caution = {
  text: string;
  /** result.utterances の添字。閉区間 [from, to] */
  from: number;
  to: number;
};

/**
 * 意図駆動モードのパス1（意図把握）の中間生成物。手順の骨格だが、
 * まだ画像も本文も無い。from/to は発話の添字（閉区間）で、時刻は持たない
 * （時刻を LLM に発明させないという lib/intent.ts の方針による）。
 */
export type PlannedStep = {
  title: string;
  /** この項目で作成者が読者に伝えたいこと */
  intent: string;
  from: number;
  to: number;
};

/** 意図駆動モードで gemma が最初に作る「マニュアルの設計図」 */
export type ManualIntent = {
  title: string;
  audience: string;
  goal: string;
  prerequisites: string[];
  /** どの手順にも紐づかなかった、マニュアル全体に関わる注意事項 */
  cautions: Caution[];
};

/**
 * 操作マニュアルの解析結果。
 * AnalysisResult のスーパーセットにしてあるので、/api/search と /api/ask は
 * コードを変えずにそのまま使える（loadAnalysis は JSON.parse の結果を
 * AnalysisResult として扱うだけなので、steps は型から見えないままランタイムには残る）。
 */
export type ManualResult = AnalysisResult & {
  steps: ManualStepWithMeta[];
  /**
   * レターボックス（画面録画の左右黒帯）を除いた実コンテンツ領域。
   * 動画フレーム全体を [0,1000] とする正規化座標。黒帯が無い動画では undefined。
   * 注釈サブエージェントが cropdetect の検出結果をここにキャッシュし、
   * 「注釈をやり直す」際に ffmpeg での再検出を省略できるようにする。
   */
  contentBox?: NormalizedBox;
  /**
   * 意図駆動モード（/api/manual/narrated/analyze）でのみ入る。
   * 完成動画モードの既存 result.json には無いので任意プロパティ。
   */
  intent?: ManualIntent;
  /** "edited" = 完成動画から（既定） / "narrated" = 実況収録から。未指定は edited 扱い */
  mode?: "edited" | "narrated";
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

/**
 * /api/manual/annotate が SSE で流すイベント。
 * ManualAnalyzeEvent とは別 union にしてある（役割が完全に分離しているため、
 * 片方を変えてももう片方の解析パイプラインに影響しない）。
 */
export type ManualAnnotateEvent =
  | { type: "start"; total: number; rounds: number }
  | { type: "round-start"; round: number; targets: number }
  | {
      type: "annotation";
      /** crop-and-zoom の何周目でこのイベントが送られたか */
      round: number;
      /** steps 配列の添字。並列実行なので順不同で届く。突合はこれで行う（time ではない） */
      index: number;
      time: number;
      /**
       * その時点での最良の注釈。周回途中でも常に「今いちばん信用できる状態」を送る
       * （N周目が found:false でも、1周目で確定した正しい枠を null で上書きしない）。
       */
      annotation: StepAnnotation | null;
      /** annotation が null のときだけ入る。棄却理由を可視化するためのもの */
      reason?: "no_json" | "not_found" | "no_valid_target" | "failed";
    }
  | { type: "round-done"; round: number; annotated: number; remaining: number }
  | { type: "done"; annotated: number }
  | { type: "error"; message: string };

/**
 * /api/manual/verify が SSE で流すイベント。
 * ManualAnnotateEvent とも別 union にしてある（役割が完全に分離しているため）。
 */
export type ManualVerifyEvent =
  | { type: "round-start"; round: number; targets: number }
  | {
      type: "verification";
      round: number;
      /** steps 配列の添字。並列実行なので順不同で届く。突合はこれで行う（time ではない） */
      index: number;
      time: number;
      /** 画像を差し替えた場合のみ入る（time/imageUrl が変わったことをクライアントに伝える） */
      replacedImageUrl?: string;
      replacedTime?: number;
      verification: StepVerification;
    }
  | { type: "round-done"; round: number; fixed: number; remaining: number }
  | { type: "done"; totalFixed: number; needsReview: number }
  | { type: "error"; message: string };

/**
 * /api/manual/narrated/analyze（意図駆動モード）が SSE で流すイベント。
 * ManualAnalyzeEvent とは別 union にしてある。info は frameCount を持てない
 * （フレーム数が意図把握の後でないと決まらないため）ので、同じ判別子で
 * 違う形のバリアントを共存させられないという lib/types.ts の既存方針上、
 * 分離が必須になる。
 */
export type ManualNarratedEvent =
  | {
      type: "info";
      id: string;
      videoUrl: string;
      duration: number;
      utteranceCount: number;
      chunkCount: number;
    }
  | { type: "utterances"; utterances: Utterance[] }
  | { type: "chunk"; index: number; total: number; items: number }
  | { type: "intent"; intent: ManualIntent }
  | { type: "plan"; planned: PlannedStep[] }
  | {
      type: "capture";
      stepIndex: number;
      total: number;
      time: number;
      imageUrl: string;
      text: string;
    }
  | {
      type: "step";
      /** planned 配列の添字。手順ごとに独立・並列で確定するので順不同で届く。突合はこれで行う */
      index: number;
      step: ManualStepWithMeta;
    }
  | { type: "summary"; text: string }
  | { type: "done"; id: string }
  | { type: "error"; message: string };
