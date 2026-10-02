# Amu

Amuは、[T3 Code](https://github.com/pingdotgg/t3code)（MITライセンス）をもとに改造したデスクトップアプリです。Claude Code、Codex、Cursorなど、手元のAIエージェントをひとつの画面から使えます。T3 Codeの公式版ではなく、個人が改造して公開しているものです。

## T3 Codeからの主な変更点

- 日本語の画面：メニューやボタンを日本語に置き換えています。
- オート（Luna）：新しい会話の最初の依頼で、Luna（gpt-6-luna）が使うモデルと思考の強さを選びます。モデル選択の左の列にある杖のアイコンから選べます。詳しくは [docs/user/luna-auto.md](docs/user/luna-auto.md) を見てください。
- 画像生成の表示：Codexで生成した画像を、会話の中にそのまま表示します。
- CLIのアップデート：Codex CLIなどに更新があると、サイドバーの下に「アップデート」が出ます。押して確認すると更新します。Codexを更新したあとはLunaの判定に使う設定でCLIを試し起動し、失敗したら自動で元の版に戻します。
- 名前とアイコン：アプリ名をAmuに、アイコンと起動画面をAmuのものに変えています。

## 必要なもの

使うエージェントのCLIを入れて、ログインしておいてください。

- Codex：[Codex CLI](https://developers.openai.com/codex/cli) を入れて `codex login`
- Claude：[Claude Code](https://claude.com/product/claude-code) を入れて `claude auth login`

オート（Luna）は、Codex CLIでChatGPTにログインしているときに使えます。

## ビルド

Node.js と pnpm 11 が必要です。

```bash
pnpm install
pnpm build
pnpm dist:desktop:dmg:arm64
```

開発中は `pnpm dev:desktop` で起動できます。

## ライセンスと元のプロジェクト

元のT3 CodeのREADMEは [docs/upstream-README.md](docs/upstream-README.md) にあります。ライセンスはT3 Codeと同じMITです。[LICENSE](LICENSE) には元の著作権表示（T3 Tools Inc.）をそのまま残しました。「T3」「T3 Code」はT3 Tools Inc.の名称で、Amuは同社と関係がありません。
