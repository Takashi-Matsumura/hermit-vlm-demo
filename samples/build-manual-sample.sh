#!/usr/bin/env bash
#
# 操作マニュアル自動生成（/manual）の検証用に、test-video.mp4 へ日本語ナレーションを
# 合成音声で足した manual-sample.mp4 を作る。
#
# macOS 専用（say コマンドを使う）。ナレーションが3文なので、発話区切れ目のフレーム
# マージが効けば手順が3つ生成されるはず（決定的な検証ができる）。
set -euo pipefail

cd "$(dirname "$0")"

VOICE=Kyoko
NARRATION="まず、ファイルメニューを開きます。次に、インポートを選びます。最後に、CSVファイルを選んで読み込みます。"

if ! say -v '?' | grep -q "^${VOICE} "; then
  echo "音声 ${VOICE} が見つかりません。'say -v ?' で日本語(ja_JP)の音声を確認してください。" >&2
  exit 1
fi

echo "ナレーションを合成中..."
say -v "$VOICE" -o narration.aiff "$NARRATION"

echo "動画に合成中..."
ffmpeg -y -i test-video.mp4 -i narration.aiff \
  -c:v copy -c:a aac -shortest manual-sample.mp4 2>/dev/null

rm -f narration.aiff

duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 manual-sample.mp4)
size=$(ls -lh manual-sample.mp4 | awk '{print $5}')
echo "完成: manual-sample.mp4 (${size} / ${duration}秒 / ナレーション3文)"
