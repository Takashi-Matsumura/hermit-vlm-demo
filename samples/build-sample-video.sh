#!/usr/bin/env bash
#
# サンプル動画 test-video.mp4 を slide*.svg から作り直す。
#
# macOS 専用。この環境の ffmpeg は freetype 無しビルドで drawtext が使えず、
# PIL や ImageMagick も入っていないため、SVG のラスタライズに qlmanage を使う。
#
# qlmanage は「正方形の」サムネイルを作るので、SVG のキャンバスは正方形にしておくこと。
# 横長の SVG を渡すと右側がクロップされる。
set -euo pipefail

cd "$(dirname "$0")"

SLIDES=(slide1 slide2 slide3)
SECONDS_PER_SLIDE=4

echo "SVG を PNG に変換中..."
for slide in "${SLIDES[@]}"; do
  rm -f "$slide.svg.png"
  qlmanage -t -s 1024 -o . "$slide.svg" >/dev/null 2>&1
  [ -f "$slide.svg.png" ] || { echo "変換に失敗: $slide.svg" >&2; exit 1; }
done

echo "動画を生成中..."
# SLIDES に足すだけで枚数を増やせるよう、入力と concat の指定を組み立てる
args=()
inputs=""
for i in "${!SLIDES[@]}"; do
  args+=(-loop 1 -t "$SECONDS_PER_SLIDE" -i "${SLIDES[$i]}.svg.png")
  inputs+="[$i:v]"
done

ffmpeg -y "${args[@]}" \
  -filter_complex "${inputs}concat=n=${#SLIDES[@]}:v=1:a=0,fps=10,format=yuv420p[v]" \
  -map "[v]" -c:v libx264 test-video.mp4 2>/dev/null

rm -f slide*.svg.png

duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 test-video.mp4)
size=$(ls -lh test-video.mp4 | awk '{print $5}')
echo "完成: test-video.mp4 (${size} / ${duration}秒 / ${#SLIDES[@]}シーン)"
