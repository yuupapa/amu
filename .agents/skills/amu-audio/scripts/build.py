"""Amu Audio: 音声を入れたミニプレーヤーHTMLを作る。

使い方:
  python3 build.py 音声1.mp3 音声2.wav ... [-o 出力.html]
  python3 build.py --manifest tracks.json [-o 出力.html] [--limit 0]

manifest は次の形のリスト。
  [{"path": "samples/a.mp3", "name": "表示名", "kind": "voice|music|sfx",
    "meta": "モデル・声などの補足", "url": "https://...（任意）"}]

既定では音声そのものを埋め込む（あとで聞き直しても鳴る）。チャット埋め込み（html_render）は
512KBまでなので、大きいファイルは ffmpeg で試聴用の軽いmp3（モノラル32kbps）に変換してから入れる。
それでも収まらない曲は、url があればそのURLから再生し、波形だけ計算して埋め込む
（ElevenLabsの一時URLは2時間で切れる）。url も無ければスキップして警告する。
--limit 0 は容量制限なし（ブラウザで直接開く保存用）。
--prefer-url は url がある曲を埋め込まずURL再生にする（チャットに出すHTMLを軽くしたいとき）。
--inline-lib は再生ライブラリ（vendor/wavesurfer.min.js）をHTMLに同梱し、ネットが無くても動くようにする。
--limit 0 のときは自動で同梱する（保存用）。チャット用は既定でCDNから読む（HTMLを約42KB軽くするため）。
"""
import argparse, base64, json, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
LIMIT = 470_000  # HTML全体の上限512KBから本体分を引いた予算
PEAKS = 160
CDN_IMPORT = "import WaveSurfer from 'https://unpkg.com/wavesurfer.js@7.12.12/dist/wavesurfer.esm.js';"


def preview_bytes(path: Path, limit: int) -> bytes:
    raw = path.read_bytes()
    if not limit or len(raw) * 4 / 3 < limit / 4:
        return raw
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "p.mp3"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(path), "-ac", "1", "-b:a", "32k", str(out)], check=True)
        return out.read_bytes()


def peaks_and_duration(path: Path) -> tuple[list[float], float]:
    sr = 8000
    pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"],
                         check=True, capture_output=True).stdout
    n = len(pcm) // 2
    vals = memoryview(pcm).cast("h")
    step = max(1, n // PEAKS)
    peaks = [max(abs(v) for v in vals[i:i + step]) / 32768 for i in range(0, n, step)][:PEAKS]
    top = max(peaks) or 1
    return [round(p / top, 2) for p in peaks], round(n / sr, 2)


def mime_of(p: Path, data: bytes) -> str:
    if data[:3] == b"ID3" or data[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return "audio/mpeg"
    return {".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".flac": "audio/flac"}.get(p.suffix.lower(), "audio/mpeg")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="*")
    ap.add_argument("--manifest")
    ap.add_argument("-o", "--out", default=str(HERE / "amu-audio.html"))
    ap.add_argument("--limit", type=int, default=LIMIT, help="埋め込みの容量上限（バイト）。0で無制限")
    ap.add_argument("--prefer-url", action="store_true", help="url がある曲はURL再生にする")
    ap.add_argument("--inline-lib", action="store_true", help="再生ライブラリを同梱する（--limit 0 では自動）")
    a = ap.parse_args()

    items = json.loads(Path(a.manifest).read_text(encoding="utf-8")) if a.manifest else [{"path": f} for f in a.files]
    base = Path(a.manifest).resolve().parent if a.manifest else Path.cwd()

    limit = a.limit
    tracks, used, notes = [], 0, []
    for it in items:
        p = (base / Path(it["path"]).expanduser()).resolve()
        t = {"name": it.get("name") or p.name}
        for k in ("kind", "meta"):
            if it.get(k):
                t[k] = it[k]
        data = b"" if a.prefer_url and it.get("url") else preview_bytes(p, limit)
        b64 = base64.b64encode(data).decode()
        if data and (not limit or used + len(b64) <= limit):
            used += len(b64)
            t["url"] = f"data:{mime_of(p, data)};base64,{b64}"
        elif it.get("url"):
            t["peaks"], t["dur"] = peaks_and_duration(p)
            t["url"] = it["url"]
            notes.append(f"URL再生（期限つき）: {t['name']}")
        else:
            notes.append(f"skip (容量オーバー): {t['name']}")
            continue
        tracks.append(t)
    for n in notes:
        print(n, file=sys.stderr)

    html = (HERE / "template.html").read_text(encoding="utf-8").replace("/*TRACKS*/[]", json.dumps(tracks, ensure_ascii=False))
    if a.inline_lib or not limit:
        lib = (HERE / "vendor" / "wavesurfer.min.js").read_text(encoding="utf-8")
        assert CDN_IMPORT in html
        html = html.replace(CDN_IMPORT, "const WaveSurfer = window.WaveSurfer;").replace(
            '<script type="module">',
            "<script>/* wavesurfer.js 7.12.12 | BSD-3-Clause | (c) katspaugh and contributors */\n" + lib + "</script>\n<script type=\"module\">", 1)
    Path(a.out).write_text(html, encoding="utf-8")
    print(f"{a.out}  tracks={len(tracks)}  size={len(html.encode()) // 1024}KB")


if __name__ == "__main__":
    main()
