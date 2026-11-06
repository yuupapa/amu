# Amu の補助ツール

Amu本体のビルドには含まれず、Macに別途配置して使うツールです。

- `amu-render-safety/`: 4K書き出し、Blender描画、長時間のffmpeg処理を始める前に、メモリと空き容量を点検します。Blenderは60フレームごとに再起動して描画します。
- `amu-agent-desktop/`: ネイティブアプリのデスクトップ操作を行うMCPサーバーと、操作の振り分けスキルです。`agent-desktop-runtime/` の依存は `npm ci` で入れます。`input-allowlist.json` は入力を許可するアプリの一覧です。

Amu Audioスキルは `.agents/skills/amu-audio/` にあります。
