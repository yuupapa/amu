# Amu

Amu は、[T3 Code](https://github.com/pingdotgg/t3code)（MIT ライセンス）をもとに改造したデスクトップアプリです。Claude Code、Codex、Cursor など、手元の AI エージェントを一つの画面から使えます。T3 Code の公式版ではなく、個人が改造して公開しているものです。

0.0.48 から、T3 Code の新しい作り（Orchestration V2）の上に載せ直しました。会話の途中で AI を乗り換える機能（Claude・Codex・Cursor・Gemini などの間）と、AI が別の AI に作業を頼む機能は T3 Code のものを使っています。

## T3 Code からの主な変更点

- 日本語の画面：画面に出る文字を辞書で日本語に置き換えています（`apps/web/src/amu/domTranslation.ts`）。会話の本文、コード、ファイル名、入力欄は置き換えません。
- オート（Luna）：新しい会話の最初の依頼で、Luna（gpt-6-luna）が使うモデルと思考の強さを選びます。モデル選択の左の列にある杖のアイコンから選べます。どの依頼にどのモデルを選ぶかの表は、`luna-routing.json` で書き換えられます。詳しくは [docs/user/luna-auto.md](docs/user/luna-auto.md) を見てください。
- 画面の分割：会話を最大 4 つまで、左右・上下に並べられます。サイドバーのスレッドを会話の画面へドラッグするか、スレッドの右クリックメニューから開きます。
- CLI のアップデート：Codex を更新したあとは、Luna の判定に使う設定で CLI を試しに起動し、失敗したら自動で元の版に戻します。
- アプリ内の更新：GitHub（yuupapa/amu）に新しい版が出ると、画面の右上でお知らせし、そのまま更新できます。
- 名前とアイコン：アプリ名を Amu に、アイコンと起動画面を Amu のものに変えています。

## 必要なもの

使うエージェントの CLI を入れて、ログインしておいてください。

- Codex：[Codex CLI](https://developers.openai.com/codex/cli) を入れて `codex login`
- Claude：[Claude Code](https://claude.com/product/claude-code) を入れて `claude auth login`

オート（Luna）は、Codex CLI で ChatGPT にログインしているときに使えます。

## ビルド

Node.js と pnpm 11 が必要です。

```bash
pnpm install
pnpm build
pnpm dist:desktop:dmg:arm64
```

開発中は `pnpm dev:desktop` で起動できます。

## 更新とリリース

Amu は起動の 15 秒後と 4 分ごとに、GitHub（yuupapa/amu）の最新リリースを確かめます。新しい版があれば画面の右上でお知らせし、ダウンロードと再起動で更新できます。入れ替えるのはアプリのコードと、それが使う部品だけで、会話・設定・`amu-local.json` はそのままです。新しい版が起動しなかったときは、自動で前の版に戻ります。

会話のデータは `~/Library/Application Support/Amu/runtime/userdata` にあります。0.0.48 は初回の起動で、それまでの `state.sqlite` を写した `statev2.sqlite` を作り、写しのほうを使います。元の `state.sqlite` は書き換えません。

リリースを作るときは、`apps/desktop/package.json` などのバージョンを上げてコミット・push してから、次を実行します（Apple Silicon の Mac で、`gh` に書き込みできるアカウントでログインしておく）。

```bash
node scripts/amu-release.mjs --notes-file notes.md --publish
```

`--publish` を外すとビルドだけをして、`release/amu-<版>/` に置きます。

## ライセンスと元のプロジェクト

元の T3 Code の README は [docs/upstream-README.md](docs/upstream-README.md) にあります。ライセンスは T3 Code と同じ MIT です。[LICENSE](LICENSE) には元の著作権表示（T3 Tools Inc.）をそのまま残しました。「T3」「T3 Code」は T3 Tools Inc. の名称で、Amu は同社と関係がありません。
