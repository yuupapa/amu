export const amuHelpEntries = [
  {
    title: "会話・AI選択",
    description:
      "Claude Code、Codex、Cursorなどを一つの画面で使えます。会話の途中でAIを切り替えられます。",
    example: "同じ会話を別のAIで続ける",
    preparation: "使うエージェントのCLIを入れ、ログインしておきます。",
  },
  {
    title: "オート",
    description: "新しい会話の最初の依頼に合わせて、使えるモデルと思考の強さを選びます。",
    example: "モデル選択の杖アイコンから「オート」を選ぶ",
    preparation:
      "判定役へのログインが必要です。添付やスラッシュコマンドを使うときは手動で選びます。",
  },
  {
    title: "Amu Creator",
    description:
      "動画や編集可能なHyperFramesプロジェクトを開き、映像を見ながら修正コメントを送れます。",
    example: "この動画プロジェクトをCreatorで開いて。字幕を編集できる状態にして",
    preparation:
      "デスクトップ版の「設定 → 連携」でAmu Creator（試験版）を有効にします。編集するプロジェクトの場所を指定してください。MP4だけを開く場合は、字幕などの編集には元のプロジェクトが必要です。",
  },
  {
    title: "Amu Audio",
    description:
      "ナレーション・BGM・効果音をチャット内で再生し、テイクを聞き比べるためのプレーヤーです。",
    example: "この音声をAmu Audioで聞き比べられるようにして",
    preparation:
      "Amu Audioスキルの導入が必要です。ナレーションや音楽の生成には別途対応サービスなどが必要で、料金やログイン条件はサービスによって異なります。",
  },
  {
    title: "Amu Gallery",
    description: "登録した生成画像や動画をAmu内で開いて確認できます。",
    example: "生成した画像をGalleryで見せて",
    preparation:
      "デスクトップ版の「設定 → 連携」でAmu ギャラリーを有効にします。画像や動画をギャラリーに登録してから開きます。生成には対応する外部ツールが必要です。",
  },
  {
    title: "ブラウザで確認",
    description: "共有プレビューでWebページを開き、AIと同じページを見ながら確認できます。",
    example: "このURLをプレビューで開いて、表示を確認して",
    preparation: "ログインが必要なページでは、対象のアカウントやブラウザの状態を確認します。",
  },
  {
    title: "画面分割・更新",
    description:
      "会話を最大4つまで左右・上下に並べられます。新しいバージョンが出ると、右上の通知からアプリを更新できます。",
    example: "サイドバーのスレッドを会話画面へドラッグする",
    preparation: "更新通知が出たら、画面の案内に沿ってダウンロードと再起動を行います。",
  },
] as const;
