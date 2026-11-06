#!/bin/sh
# 使い方: sh make-fixtures.sh <空の作業フォルダ>  → そのフォルダで node regression.mjs / carry-offline.mjs を回す
set -e
T="$1"; SK="$(cd "$(dirname "$0")/.." && pwd)"; mkdir -p "$T/media"; cd "$T"
for x in "a 330 3" "b 440 4" "c 550 2" "v1 300 6" "v2 360 6"; do set -- $x; ffmpeg -v error -y -f lavfi -i "sine=f=$2:d=$3" -ac 1 -b:a 32k "media/$1.mp3"; done
echo "not audio" > media/bad.mp3
cat > media/tracks.json <<'J'
[{"path":"a.mp3","name":"ナレーション テイクA","kind":"voice","meta":"eleven_v4 / Kuni・解説向け男性 / 「こんにちは。これはAmuオーディオの再生テストです。ElevenLabsで作った音声を、チャットの中ですぐに確認できます」"},
 {"path":"b.mp3","name":"BGM ローファイ","kind":"music","meta":"eleven_music_v2_5 / ピアノと軽いドラム"},
 {"path":"c.mp3","name":"効果音 チャイム","kind":"sfx","meta":"eleven_text_to_sound_v2"},
 {"path":"bad.mp3","name":"壊れたファイル","kind":"sfx","meta":"テスト用"}]
J
cat > media/t2.json <<'J'
[{"path":"v1.mp3","name":"テイクA","kind":"voice"},{"path":"v2.mp3","name":"テイクB","kind":"voice"},{"path":"b.mp3","name":"BGM","kind":"music"}]
J
python3 "$SK/scripts/build.py" --manifest media/tracks.json -o full.html
python3 "$SK/scripts/build.py" -o empty.html
python3 "$SK/scripts/build.py" --manifest media/t2.json -o carry.html
python3 "$SK/scripts/build.py" --manifest media/t2.json --limit 0 -o offline.html
