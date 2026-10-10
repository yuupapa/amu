/**
 * Japanese labels for HyperFrames Studio, ported from `~/HyperFrames/hf-studio-ja`
 * (`dict.js` and the applier in `content.js`). Pure: the overlay applies
 * `translate` to Studio text nodes and attributes. Proper nouns (HyperFrames,
 * Framey, MP4) stay as they are.
 */

/** Exact matches (English -> Japanese). */
const JA_DICT: Readonly<Record<string, string>> = {
  // ヘッダー
  Capture: "静止画を保存",
  "Capture current frame": "今のフレームを静止画で保存",
  Inspector: "インスペクター",
  "Switch to dark theme": "ダークモードに切り替え",
  "Switch to light theme": "ライトモードに切り替え",
  Window: "ウィンドウ",
  "Edit with Framey": "Framey で編集",
  New: "新機能",
  Export: "書き出し",
  "Open this project in the HyperFrames desktop app and edit it with Framey":
    "このプロジェクトを HyperFrames デスクトップアプリで開き、Framey（AI アシスタント）にチャットで編集を頼めます",
  Slideshow: "スライドショー",
  "Reset layout": "パネル配置を元に戻す",

  // パネル・タブ
  Compositions: "コンポジション",
  Assets: "素材",
  Code: "コード",
  Catalog: "カタログ",
  Preview: "プレビュー",
  Design: "デザイン",
  Layers: "レイヤー",
  Renders: "書き出し履歴",
  Variables: "変数",
  Timeline: "タイムライン",
  "Resize rows": "上下の境目をドラッグして高さを変更",
  "Resize columns": "左右の境目をドラッグして幅を変更",
  "Panel menu": "パネルのメニュー",
  "Maximize panel": "パネルを最大化",
  "Close group": "このパネル群を閉じる",
  "Composition preview": "コンポジションのプレビュー",
  "Composition canvas": "コンポジションの画面",
  "Variables opened": "変数パネルを開きました",

  // コンポジション一覧
  Root: "ルート",
  ROOT: "ルート",
  "Root composition — opens automatically on load":
    "ルート（全体）のコンポジション。開いたときに最初に表示されます",
  Lint: "チェック",
  "lint findings, including errors": "件の指摘（エラーを含む）",
  "1 lint finding": "指摘 1 件",
  "Drop media here": "ここに素材をドロップ",

  // プレビュー上のツール
  "Toggle ruler": "定規の表示を切り替え",
  "Ruler off": "定規：非表示",
  "Ruler on": "定規：表示中",
  "Toggle safe margins": "セーフエリア（文字を置いてよい範囲）の表示を切り替え",
  "Safe margins off": "セーフエリア：非表示",
  "Safe margins on": "セーフエリア：表示中",
  "Toggle snap": "スナップ（吸着）を切り替え",
  "Snap enabled (S)": "スナップ：オン（S キー）",
  "Snap disabled (S)": "スナップ：オフ（S キー）",
  "Toggle grid": "グリッド（方眼）の表示を切り替え",
  "Grid hidden (G) — right-click for spacing options":
    "グリッド：非表示（G キー）。右クリックで間隔を設定",
  "Grid shown (G) — right-click for spacing options":
    "グリッド：表示中（G キー）。右クリックで間隔を設定",
  "Grid options": "グリッドの設定",
  "Grid spacing": "グリッドの間隔",
  "Snap to grid": "グリッドに吸着",
  Play: "再生",
  Pause: "一時停止",
  "Preview volume": "プレビューの音量",
  "Mute audio": "ミュート",
  "Unmute audio": "ミュート解除",
  "Playback speed": "再生速度",
  "Playback speed options": "再生速度の選択",
  "Enable loop playback": "ループ再生をオン",
  "Disable loop playback": "ループ再生をオフ",
  "Enter fullscreen": "全画面表示",
  "Exit fullscreen": "全画面表示を終了",
  "Shortcuts and tools": "ショートカットとツール",
  "Keyboard shortcuts and tools": "キーボードショートカットとツール",

  // タイムラインのツールバー
  Undo: "元に戻す",
  Redo: "やり直す",
  "Timeline tools": "タイムラインのツール",
  "Timeline tool: Select": "タイムラインのツール：選択",
  "Timeline tool: Split": "タイムラインのツール：分割",
  Select: "選択",
  Split: "分割",
  "Select leftward": "左側をまとめて選択",
  "Select rightward": "右側をまとめて選択",
  "Linked Selection": "リンク選択（つながったクリップを一緒に選ぶ）",
  "Toggle timeline snapping": "タイムラインのスナップ（吸着）を切り替え",
  "Toggle ripple edit": "リップル編集（後ろのクリップを詰める）を切り替え",
  "Toggle audio meters": "音量メーターの表示を切り替え",
  "Add keyframe at playhead": "再生位置にキーフレームを追加",
  "Auto-record manual edits as keyframes": "手で動かした変更を自動でキーフレームとして記録",
  "Split at playhead": "再生位置でクリップを分割",
  "Add beat at playhead": "再生位置に拍（ビート）の目印を追加",
  "Hide thumbnails — labels only": "サムネイルを隠して名前だけ表示",
  "Show thumbnails": "サムネイルを表示",
  "Fit timeline to width": "タイムライン全体を幅に合わせる",
  "Zoom out": "縮小",
  "Zoom in": "拡大",
  "Timeline zoom": "タイムラインの拡大率",
  "Timeline zoom level": "タイムラインの拡大率",
  "Timeline track view": "タイムラインのトラック表示",
  "Timeline tracks": "タイムラインのトラック",
  Fit: "全体",
  "Hide lanes": "レーンを隠す",
  "Show lanes": "レーンを表示",
  "No effects": "エフェクトなし",
  Crop: "切り抜き",
  Visual: "見た目",
  visual: "見た目",
  Scale: "拡大率",
  scale: "拡大率",
  "keyframes,": "個のキーフレーム、",
  "ease controls": "個のイージング（動きの緩急）",
  "Space picks up. Up and Down choose a new track. Enter drops. Escape cancels.":
    "Space でつかむ → ↑↓ で移動先のトラックを選ぶ → Enter で置く。Esc で取り消し",

  // デザインパネル（何も選んでいないとき）
  "Nothing selected": "何も選ばれていません",
  "Click any element on the canvas to edit it, or drag to select several.":
    "画面上の要素をクリックすると編集できます。ドラッグで複数を選べます。",
  "Record a gesture": "動きを手で記録する",
  "Record gesture": "動きを手で記録",
  "Record gesture (R)": "動きを手で記録（R キー）",
  "Describe a change to the agent": "AI エージェントに変更内容を伝える",

  // デザインパネル（要素を選んだとき）
  Text: "テキスト",
  "Text layers": "テキストのレイヤー",
  "Add text field": "テキスト欄を追加",
  "Remove text field": "テキスト欄を削除",
  Content: "内容",
  Font: "フォント",
  Size: "サイズ",
  Weight: "太さ",
  "100 · Thin": "100 · 極細",
  "200 · Extra Light": "200 · 細め（強）",
  "300 · Light": "300 · 細め",
  "400 · Regular": "400 · 標準",
  "500 · Medium": "500 · やや太め",
  "600 · Semi Bold": "600 · 太め（弱）",
  "700 · Bold": "700 · 太字",
  "800 · Extra Bold": "800 · 極太",
  "900 · Black": "900 · 最も太い",
  "Letter spacing": "文字の間隔",
  "Line height": "行の高さ",
  Align: "揃え",
  "Case · Style": "大文字小文字・書体",
  Color: "色",
  Style: "スタイル",
  Layout: "レイアウト（位置とサイズ）",
  Motion: "モーション（動き）",
  "1 effect": "エフェクト 1 個",
  "Ask agent about this element": "この要素について AI エージェントに聞く",
  "Hide element": "要素を隠す",
  "Show element": "要素を表示",
  "Copy element info for any AI agent": "AI エージェントに渡すための要素情報をコピー",
  "Copy element info to clipboard": "要素情報をクリップボードにコピー",
  "Clear selection": "選択を解除",
  Collapse: "折りたたむ",
  Expand: "広げる",
  "Collapse children": "中身を折りたたむ",
  "Scroll or use Arrow keys to adjust": "スクロールか矢印キーで値を調整",
  "Pick color color": "色を選ぶ",
  left: "左揃え",
  center: "中央揃え",
  right: "右揃え",
  justify: "両端揃え",
  uppercase: "すべて大文字",
  lowercase: "すべて小文字",
  capitalize: "単語の先頭を大文字",
  upright: "標準",
  italic: "斜体",
  Opacity: "不透明度",
  Position: "位置",
  Rotation: "回転",
  Width: "幅",
  Height: "高さ",
  Fill: "塗り",
  Stroke: "線",
  Shadow: "影",
  Radius: "角の丸み",
  "Blend mode": "描画モード",
  Effects: "エフェクト",
  Duration: "長さ",
  Start: "開始",
  End: "終了",
  Volume: "音量",
  Speed: "速度",
  Group: "グループ",
  Shape: "図形",
  Image: "画像",
  Video: "動画",
  Audio: "音声",
  layer: "レイヤー",

  // 素材パネル
  "This project": "このプロジェクト",
  "All projects": "すべてのプロジェクト",
  "Import media": "素材を読み込む",
  All: "すべて",
  Images: "画像",
  Fonts: "フォント",
  "In use": "使用中",
  "in use": "使用中",
  Unused: "未使用",
  Voice: "音声（ナレーション）",
  Added: "追加済み",
  "Search assets": "素材を検索",
  "Search assets...": "素材を検索…",

  // コード・カタログ・変数
  Files: "ファイル",
  "New File": "新しいファイル",
  "New Folder": "新しいフォルダ",
  "Unfold line": "行を展開",
  "Fold line": "行を折りたたむ",
  "Loading blocks…": "部品を読み込み中…",
  "Previewing defaults": "初期値でプレビュー中",
  "+ Add variable": "+ 変数を追加",

  // 書き出し
  Format: "形式",
  Resolution: "解像度",
  "Frame rate": "フレームレート",
  Quality: "画質",
  Standard: "標準",
  High: "高画質",
  Draft: "下書き（低画質・速い）",
  "No renders yet": "まだ書き出していません",
  "About video formats": "動画形式について",
  "Rendering…": "書き出し中…",
  "Compiling composition": "コンポジションを準備中",
  "Extracting video frames": "動画のフレームを取り出し中",
  Cancel: "キャンセル",
  Cancelled: "キャンセルしました",
  Completed: "完了",
  Failed: "失敗",
  Download: "ダウンロード",
  Open: "開く",
  Delete: "削除",
  "A render is already in progress": "すでに書き出し中です",

  // ショートカット一覧
  "Jump to frame": "フレームへ移動",
  Go: "移動",
  "frame number": "フレーム番号",
  "Work area": "作業範囲",
  "In-point": "開始点（イン）",
  "Out-point": "終了点（アウト）",
  Playback: "再生",
  "Play / Pause": "再生／一時停止",
  "Play backward": "逆再生",
  Stop: "停止",
  "Play forward": "順再生",
  "Toggle mute": "ミュートを切り替え",
  "Toggle loop": "ループを切り替え",
  "Step 1 frame": "1 フレーム送る",
  "Step 10 frames": "10 フレーム送る",
  "Toggle fullscreen": "全画面を切り替え",
  "Keyframes (when an element is selected)": "キーフレーム（要素を選んでいるとき）",
  "Add / remove keyframe at playhead": "再生位置のキーフレームを追加／削除",
  "Delete selected keyframe": "選んだキーフレームを削除",
  Editing: "編集",
  "Copy element": "要素をコピー",
  "Paste element": "要素を貼り付け",
  "Cut element": "要素を切り取り",
  "Split clip at playhead": "再生位置でクリップを分割",
  "Audio Gain for clips with sound": "音のあるクリップの音量",
  "Razor tool: split all tracks": "レーザーツール：全トラックをまとめて分割",
  "Select clips starting before the playhead": "再生位置より前に始まるクリップを選択",
  "Select clips running at or after the playhead": "再生位置以降のクリップを選択",
  "Group elements": "要素をグループ化",
  Ungroup: "グループ解除",
  "Delete selected element (no keyframe selected)":
    "選んだ要素を削除（キーフレームを選んでいないとき）",
  "Gesture recording modifiers": "動きの記録中に使うキー",
  Drag: "ドラッグ",
  "Record x / y position": "x / y の位置を記録",
  Scroll: "スクロール",
  "Record z depth": "奥行き（z）を記録",
  "Record rotationX / rotationY": "縦・横の傾き（rotationX / rotationY）を記録",
  "Record rotation": "回転を記録",
  "Record opacity": "不透明度を記録",
  "Record scale": "拡大率を記録",
  Canvas: "画面（キャンバス）",
  "Move element / add keyframe": "要素を動かす／キーフレームを追加",
  "Move entire animation path": "動きの軌道ごと移動",
  "Uniform resize": "縦横比を保って拡大縮小",
  "Drag edge": "端をドラッグ",
  "Crop a side": "片側を切り抜く",
  "Drag center": "中央をドラッグ",
  "Reposition the crop": "切り抜く位置を動かす",
  Panels: "パネル",
  "Compositions tab": "コンポジションのタブ",
  "Assets tab": "素材のタブ",
  "Set in-point": "開始点を設定",
  "Clear in-point": "開始点を解除",
  "Set out-point": "終了点を設定",
  "Clear out-point": "終了点を解除",
  "Jump to in-point": "開始点へ移動",
  "Jump to out-point": "終了点へ移動",
};

const entry = (key: string): string | undefined =>
  Object.prototype.hasOwnProperty.call(JA_DICT, key) ? JA_DICT[key] : undefined;
const word = (key: string): string => entry(key) ?? key;

type Pattern = readonly [RegExp, (groups: ReadonlyArray<string>) => string];

/** Labels whose variable part is a number. Safe on any Studio text. */
const COUNTED_PATTERNS: ReadonlyArray<Pattern> = [
  [/^Renders \((\d+)\)$/, ([, a]) => `書き出し履歴（${a}）`],
  [/^Render progress: (\d+)%$/, ([, a]) => `書き出しの進み具合：${a}%`],
  [/^Hide track (\d+)$/, ([, a]) => `トラック ${a} を隠す`],
  [/^Show track (\d+)$/, ([, a]) => `トラック ${a} を表示`],
  [/^(\d+) clips?$/, ([, a]) => `${a} 個のクリップ`],
  [/^Track (\d+)$/, ([, a]) => `トラック ${a}`],
  [/^Preview volume: (\d+)%$/, ([, a]) => `プレビューの音量：${a}%`],
  [/^(\d+) lint findings, including errors$/, ([, a]) => `指摘 ${a} 件（エラーを含む）`],
  [/^(\d+) lint findings$/, ([, a]) => `指摘 ${a} 件`],
  [/^(\d+) effects$/, ([, a]) => `エフェクト ${a} 個`],
];

/**
 * Labels carrying a name (a file, a layer, a property). They would also match
 * user content such as a caption "Render final", so they apply only to Studio
 * chrome: buttons, menus, tabs, labels and tooltip attributes.
 */
const NAMED_PATTERNS: ReadonlyArray<Pattern> = [
  [/^Close (.+)$/, ([, a = ""]) => `「${word(a)}」を閉じる`],
  [/^Open composition (.+)$/, ([, a]) => `コンポジション「${a}」を開く`],
  [/^Add (.+) to timeline at playhead$/, ([, a]) => `「${a}」を再生位置でタイムラインに追加`],
  [/^Render (.+)$/, ([, a]) => `「${a}」を書き出す`],
  [/^Hide (.+) lanes$/, ([, a]) => `「${a}」のレーンを隠す`],
  [/^Show (.+) lanes$/, ([, a]) => `「${a}」のレーンを表示`],
  [/^Previous (.+) keyframe$/, ([, a = ""]) => `前の「${word(a)}」キーフレームへ`],
  [/^Next (.+) keyframe$/, ([, a = ""]) => `次の「${word(a)}」キーフレームへ`],
  [/^Add (.+) keyframe$/, ([, a = ""]) => `「${word(a)}」のキーフレームを追加`],
  [/^(\w+) keyframes$/, ([, a = ""]) => `「${word(a)}」のキーフレーム`],
  [
    /^(\w+) keyframe at ([\d.]+)s( \(before clip\))?$/,
    ([, a = "", t, b]) => `${t} 秒の「${word(a)}」キーフレーム${b ? "（クリップ開始前）" : ""}`,
  ],
  [/^(.+) · before clip$/, ([, a]) => `${a} · クリップ開始前`],
  [/^Edit (\S+) easing after ([\d.]+)s$/, ([, e, t]) => `${t} 秒からの動きの緩急（${e}）を編集`],
  [/^Edit (\S+) easing$/, ([, e]) => `動きの緩急（${e}）を編集`],
  [/^(.+), ([\d.]+) to ([\d.]+) seconds$/, ([, a, s, e]) => `${a}（${s}〜${e} 秒）`],
  [/^(.+) • ([\d.]+)s – ([\d.]+)s$/, ([, a, s, e]) => `${a} • ${s}〜${e} 秒`],
  [/^Play preview of (.+)$/, ([, a]) => `「${a}」を試し再生`],
  [
    /^(.+) — open, drag to timeline, right-click for actions$/,
    ([, a]) => `${a}：クリックで開く／タイムラインへドラッグ／右クリックで操作`,
  ],
  [
    /^(.+) — copy path, drag to timeline, right-click for actions$/,
    ([, a]) => `${a}：クリックでパスをコピー／タイムラインへドラッグ／右クリックで操作`,
  ],
  [/^Select off-canvas element (.+)$/, ([, a]) => `画面外の要素を選ぶ：${a}`],
  [/^Off-canvas: (.+) — click to select$/, ([, a]) => `画面外の要素：${a}（クリックで選択）`],
  [/^Auto · (.+)$/, ([, a]) => `自動 · ${a}`],
  [/^fill set · (.+)$/, ([, a]) => `塗り設定 · ${a}`],
];

/** Where a text sits: Studio chrome (controls, tooltips) or anything else, including user content. */
export type TranslationContext = "chrome" | "content";

/**
 * Japanese for one Studio label, keeping its surrounding whitespace, or `null`
 * when the text has no Latin letters or no known translation. Name-carrying
 * patterns apply only in `chrome`. Its own output never translates again, so a
 * MutationObserver applying it does not loop.
 */
export const translate = (raw: string, context: TranslationContext = "chrome"): string | null => {
  const text = raw.trim();
  if (text === "" || !/[A-Za-z]/.test(text)) return null;
  const lead = raw.slice(0, raw.length - raw.trimStart().length);
  const trail = raw.slice(raw.trimEnd().length);
  const exact = entry(text);
  if (exact !== undefined) return lead + exact + trail;
  const patterns =
    context === "chrome" ? [...COUNTED_PATTERNS, ...NAMED_PATTERNS] : COUNTED_PATTERNS;
  for (const [pattern, render] of patterns) {
    const match = pattern.exec(text);
    if (match) return lead + render(match.map((group) => group ?? "")) + trail;
  }
  return null;
};
