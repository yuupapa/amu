---
name: amu-audio
description: 音声をチャットの中で聞けるミニプレーヤー「Amu Audio」を出すスキル。ElevenLabs・Fish Audio・VOICEVOX・Suno・その他のTTSや音楽生成（MCP・API・CLIのどれでも）でナレーション・セリフ・BGM・効果音を作ったら、ユーザーが指示しなくても報告の前に必ずこれで表示する。「音声を聞かせて」「BGMを確認したい」「テイクを聞き比べたい」「オーディオプレーヤーで」「Amuオーディオ」でも起動。波形・種類ラベル・モデルや声のメモつきのプレイリストを html_render でチャットに埋め込む。
---

# Amu Audio — チャット内ミニオーディオプレーヤー

wavesurfer.js 7.12.12（BSD-3、GitHub公開）を使った小さなプレーヤー。チャット用は unpkg CDN から読み（HTMLを約42KB軽くするため）、保存用（`--limit 0`）は `scripts/vendor/wavesurfer.min.js` を同梱してネットが無くても鳴る。ライセンスは `scripts/vendor/LICENSE`。音声を作ったら「できました」の前にこれで聞ける形にして出す。

Claude Code・Codex・Cursor・Gemini CLI・Antigravity・Hermes のどこから使っても同じ手順になる（各エージェントの skills フォルダから、正本 `~/.claude/skills/amu-audio` へのリンクで見える）。以下の `scripts/` `tests/` はこのスキルのフォルダからの相対パス。

道具は `scripts/` にある。
- `template.html` … プレーヤー本体。T3 のテーマ変数に合わせて色が変わり、単体で開いてもダーク系の色で崩れない
- `build.py` … 音声とメモの一覧（manifest）から、プレーヤーHTMLを作る
- 同じ種類（`kind`）の曲どうしで切り替えると再生位置を引き継ぐ（テイクの聞き比べ用）。種類が変わるとき・自動で次へ進むときは頭から

## 手順

1. **音声をローカルに保存する。** ツールごとの取り方:
   - ElevenLabs MCP: `creative_get_flow_run_status` の `content_url` を、完了した直後に `curl -sfL -o` で落とす（このURLは**2時間で切れる**）
   - Fish Audio・ElevenLabs などの API / CLI: 返ってきた音声バイトをそのままファイルに保存する（URLで返るものは期限を確認して `url` にも書く）
   - VOICEVOX・ローカルTTS: 出力した wav をそのまま使う
   - Suno など外部サービス: ダウンロードしたファイルを使う
   いずれも保存先は作業中のプロジェクト内の `audio/` など。ファイル名は `01_ナレーション_声名_A.mp3` のように種類と順番が分かる形にする
2. **manifest を書く**（音声と同じフォルダに `tracks.json`）:

   ```json
   [{"path": "01_ナレーション_Kuni_A.mp3", "name": "ナレーション テイクA", "kind": "voice",
     "meta": "eleven_v4 / Kuni・解説向け男性 / 「読ませた文の冒頭…」", "url": "https://…（任意）"}]
   ```
   - `kind` は `voice`（ナレーション）／`music`（BGM）／`sfx`（効果音）。色付きラベルになる
   - `meta` にはモデル、声の名前、読ませた文やプロンプトの要約を短く書く
   - `url` は ElevenLabs の `content_url`。チャットに出すHTMLを軽くするときに使う。期限つきのURLはファイルに残し続けない（作業用の一時フォルダに置く manifest にだけ書く）
3. **チャット用HTMLを作る**:
   - URLがまだ有効なら: `python3 scripts/build.py --manifest tracks.json --prefer-url -o <一時フォルダ>/chat.html`（波形だけ計算して埋め込むので十数KBで済む）
   - URLが無い・切れている: `python3 scripts/build.py --manifest tracks.json -o <一時フォルダ>/chat.html`（音声を埋め込む。上限512KBに収まるよう自動で軽くし、収まらない曲は警告してスキップする）
   - 音声を埋め込んだHTMLは、そのまま html_render に渡すぶん出力が重くなる。数百KBになるときは `--prefer-url` を優先し、ダメならファイル数を減らす
4. **保存用も作る**: `python3 scripts/build.py --manifest tracks.json --limit 0 -o amu-audio.html` を音声と同じフォルダに置く。ブラウザで直接開けばいつでも鳴る（URLが切れても使える控え）
5. **出す**: chat.html を読んで `html_preview` で確かめる（console に `ws error` や読み込み失敗が無いこと、全曲の長さが出ること）→ `html_render`（height は preview の contentHeight）
   - どちらも Amu（T3 Code）の MCP ツール。ツール名に `mcp__t3_code__` などの接頭辞が付くことがある。一覧に見えなくても、一度は直接呼んでみる
   - ACP 経由のエージェントでツールが出てこないときは、T3 の案内どおり `ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" ${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call html_render '{"title":"Amu Audio","height":<高さ>,"html":<HTML文字列>}'` で呼ぶ
   - それでも使えない環境（Amu の外の CLI など）では、手順4の保存用HTMLを `open <パス>`（macOS）でブラウザに開き、チャット埋め込みはできなかったと正直に報告する
6. **報告に添えること**: URL再生にした場合は**再生できる期限の時刻**、保存用HTMLと音声の保存先、使ったクレジット

## 知っておくこと

- チャットの iframe はローカルファイル（`/Users/...`）も `127.0.0.1` も読めない。音声はデータ埋め込みか、https のURLで渡す
- ElevenLabs の一時URLは CORS が無く fetch できない。`<audio>` での再生はできるので、`build.py` が波形（peaks）と長さを先に計算して渡す
- 三観レビュー済み（2026-10-20、第2巡で全体Green）。記録は `docs/SANKAN-2026-10-20-amu-audio.md`。テンプレートを直したら `sh tests/make-fixtures.sh <空フォルダ>` → `node tests/regression.mjs <同じフォルダ>`（28項目）と `node tests/carry-offline.mjs <同じフォルダ>`（8項目）を全項目OKにしてから使う。Playwright は kintsugi スキルの node_modules を借りている
- 空のプレーヤー（ドロップで追加する版）は引数なしの `python3 scripts/build.py -o amu-audio.html` で作れる
- 生成のテイク数は、ElevenLabs MCP の既定（4）に従う。ユーザーが費用を気にしている、または動作テストだけのときは減らしてよく、その場合は減らしたことを報告する
