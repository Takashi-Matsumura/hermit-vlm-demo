# 動画言語化デモ

ローカルの VLM で動画を日本語に言語化する Next.js デモ。クラウド API は一切使わない。

動画を投げると、シーンが切り替わる瞬間だけを自動で抜き出し、各フレームを Qwen3-VL-8B が日本語で説明し、gemma-4-12b が全体を要約して章に分割する。キャプションは bge-m3 でベクトル化してあるので、「売上のグラフ」のような自然文でシーンを検索できる。

動画について自然文で質問することもできる。まずシーン説明のテキストだけで gemma-4-12b が回答し、色や画面内の文字など説明文に書かれていない細部を聞かれた場合だけ、関連フレームの画像を Qwen3-VL に見せ直して回答する。

音声トラックがあれば whisper.cpp で日本語の発話も書き起こし、全体要約・章分割・質問応答・シーン検索のすべてに反映する。音声が無い動画は今まで通り、文字起こし関連の処理も UI も一切出さない。

## 必要な環境

`llama-server` が以下の3ポートで動いていること。

| Port | モデル | 役割 |
| --- | --- | --- |
| 8084 | Qwen3-VL-8B-Instruct Q4_K_M + mmproj F16 | フレームの言語化・OCR |
| 8080 | gemma-4-12b-it Q4_K_M | 要約・章分割 |
| 8082 | bge-m3 | シーン検索用の embeddings |

`ffmpeg` / `ffprobe` も必要（シーン検出とフレーム抽出に使う）。

音声の文字起こしには `whisper.cpp`（`whisper-cli`）を使う。`brew install whisper-cpp` で入る。
`WHISPER_MODEL` にモデルファイルのパスを設定していない場合は、文字起こし機能そのものが無効になる
（既存の映像解析・要約・検索には一切影響しない）。

Qwen3-VL の起動例:

```bash
llama-server \
  -m Qwen3VL-8B-Instruct-Q4_K_M.gguf \
  --mmproj mmproj-Qwen3VL-8B-Instruct-F16.gguf \
  --host 127.0.0.1 --port 8084 \
  -ngl 999 -c 16384 \
  --temp 0.7 --top-p 0.8 --top-k 20 --presence-penalty 1.5 \
  --flash-attn on --metrics --cache-reuse 256
```

エンドポイントや閾値は `.env.local` で変更できる。

## 起動

```bash
npm run dev
```

http://localhost:3000 を開いて動画ファイルを選ぶ。

## 動作確認

検証用の素材を `samples/` に置いてある。

| ファイル | 内容 |
| --- | --- |
| `samples/test-video.mp4` | 12秒・3シーンのスライド動画（106KB） |
| `samples/slide{1,2,3}.svg` | 元スライド。編集して動画を作り直せる |
| `samples/build-sample-video.sh` | SVG から動画を再生成する（macOS 専用） |

`samples/test-video.mp4` を選んで、次のようになれば正常に動いている。

- シーン検出で **0.0 / 4.0 / 8.0 秒**の3フレームが抽出される
- キャプションに「1,240万円」「118%」「1,820件」などの数値が正確に出る
- 「休眠顧客の課題」で検索すると **0:08 のまとめシーンが1位**になる（語句が一致していないので、ベクトル検索が効いているかの確認になる）
- 全体が **20秒前後**で完了する

スライドを編集したら動画を作り直す:

```bash
./samples/build-sample-video.sh
```

各シーンの長さは `SECONDS_PER_SLIDE`、枚数は `SLIDES` 配列で変えられる。ラスタライズに `qlmanage` を使う都合で **SVG のキャンバスは正方形にしておくこと**（横長だと右側がクロップされる）。

### 画面録画で試す

スライド動画はカットが明確なのでシーン検出が効くが、**画面録画は挙動がまったく違う**（後述）。等間隔フォールバックの確認には、Wikimedia Commons の CC BY 3.0 素材が使える。サイズが大きいのでリポジトリには含めていない。

```bash
curl -O https://upload.wikimedia.org/wikipedia/commons/c/c8/Or-import-flat-csv.ogv          # OpenRefine の CSV 取り込み / 2880x1800 / 67秒
curl -O https://upload.wikimedia.org/wikipedia/commons/0/0a/How_to_make_a_wikilink.webm     # Wikipedia ビジュアルエディタ / 2560x1440 / 84秒
curl -O https://upload.wikimedia.org/wikipedia/commons/1/1c/Wikipedia_video_tutorial-1-Editing-en.ogv  # 低解像度・長尺 / 400x224 / 197秒
```

`Or-import-flat-csv.ogv` は等間隔で7フレームが選ばれ、**114秒**で完了する。`countries.csv` やプロジェクト名、列区切りの設定まで読み取れれば正常。

## 構成

```
app/
  page.tsx              UI。SSE を読みながらタイムラインを逐次描画する
  api/analyze/route.ts  動画を受け取り、進捗を SSE で流しながら解析する
  api/search/route.ts   キャプションのベクトル検索
  api/ask/route.ts      動画への質問応答（テキスト→必要なら画像にエスカレーション）
lib/
  llm.ts                llama-server 3系統のクライアント
  video.ts              ffmpeg / ffprobe ラッパー
  audio.ts              whisper.cpp による音声の文字起こし
  analysis.ts           result.json のロードとベクトル検索（search / ask 共通）
  types.ts              サーバ・クライアント共有の型
samples/                動作確認用のサンプル動画とその生成スクリプト
```

処理の流れ:

```
動画 → ffprobe でシーン検出 → 各シーンのフレームを PNG 抽出
     → Qwen3-VL で1枚ずつ言語化（SSE で逐次返す）
     → （音声トラックがあれば）whisper.cpp で文字起こし。フレーム言語化と並行実行
     → gemma-4-12b で要約 + 章分割（映像説明 + 発話） / bge-m3 でベクトル化

質問応答: 質問をベクトル検索（映像キャプション + 発話） → gemma-4-12b がテキストだけで回答を試みる
        → 細部が判断できないときだけ、上位フレームの画像を Qwen3-VL に見せ直す
```

## 実測性能

MacBook Air M5 (32GB) での計測値:

- 画像1枚 ≒ **prompt 1,050 tokens**、**1フレームあたり 5〜7秒**
- 3フレームの動画で全体 **約21秒**（要約・章分割・ベクトル化を含む）

処理時間の大半は画像エンコードなので、出力を短くしても1フレームあたりの下限は縮まらない。フレーム数がそのまま待ち時間に効く。

## 実装上の注意

- **画面録画ではシーン検出がほとんど機能しない。** `select=gt(scene,N)` は全画面の色ヒストグラム差分を見るが、画面録画の変化は局所的（メニューが開く、文字が入力される）なので閾値をいくら下げても反応しない。実測では OpenRefine のチュートリアル動画（67秒）が閾値 0.02 でも 1フレームだった。そのため検出数が `MIN_SCENE_FRAMES`（既定3）に届かなければ**等間隔抽出に自動で切り替える**。どちらが使われたかは UI に「3シーン」「7フレーム（等間隔）」と出る。
- **シーン検出の閾値は 0.2**。スライドのように変化が緩やかな素材では、よく使われる 0.3 だと検出数がゼロになる。`SCENE_THRESHOLD` で調整する。
- **先頭フレームはシーン検出に引っかからない**。「直前フレームとの差分」で判定するため、0秒は明示的に足している。
- **フレームは `FRAME_MAX_WIDTH`（既定1600px）に縮小してから VLM に渡す。** 解像度は prompt トークン数と処理時間に直結する。実測: 2880×1800 で 4,039 tok / 59.7秒 → 1600px で 1,589 tok / 30.9秒。**画面内の文字は変わらず読み取れた**（動画1本で 279秒 → 114秒）。1280px まで落とすと具体的な文字の読み取りが落ちたので、1600px を既定にしている。
- **gemma-4-12b は reasoning モデル**。`chat_template_kwargs: {enable_thinking: false}` を付けないと思考だけで `max_tokens` を使い切り、`content` が空で返る。
- **`MAX_FRAMES`（既定16）を超えたフレームは等間隔で間引く**。長い動画で推論が終わらなくなるのを防ぐため。
- アップロードされた動画と抽出フレームは `public/uploads/<uuid>/` に置かれる。`.gitignore` 済みだが、自動削除はしないので溜まったら消すこと。
- **音声認識は whisper-cli を都度起動する方式。** モデルロードは実測 137ms、32秒の動画の文字起こし全体でも3.1秒程度と軽量なため、llama-server のような常駐サーバ化はしていない。音声トラックが無い動画、`WHISPER_MODEL` 未設定、文字起こし自体の失敗は、いずれも動画解析全体を止めずに黙ってスキップする（UIにも字幕関連の要素が一切出ない）。

## 前提と制約

**localhost で1人が使うデモとして作ってある。そのまま公開しないこと。**

- **認証が無い**。解析結果の URL (`/uploads/<uuid>/...`) と `/api/search` は、uuid を知っていれば誰でも読める。共有環境に置くなら認証と、uuid ではなく所有者に紐づくアクセス制御が要る。
- **アップロードされたファイルは消えない**。`public/uploads/` に溜まり続ける。
- 動画は `arrayBuffer()` で一旦メモリに載せるため、上限を `MAX_UPLOAD_MB`（既定 500MB）で制限している。大きな動画を扱うならストリーミング書き込みに変えること。
- 1リクエストが数十秒〜数分ブロックする。同時に何本も投げると llama-server 側で詰まる。
