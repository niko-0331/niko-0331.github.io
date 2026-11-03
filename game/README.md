# 沈黙の五限目

診断で決まる分岐ホラーゲーム。静的サイトなので GitHub Pages でそのまま動きます。

## ファイル
- `index.html` / `style.css` / `script.js`（エンジン）/ `story.js`（シナリオ・診断・ボイス割り当て）
- `assets/img/` 立ち絵（汐音・日向・小春・モブ）
- `assets/voice/` ボイス（wav）

## GitHub Pages で公開する
1. リポジトリのルートにこのフォルダの中身をすべて置く（index.html がルート）。
2. Settings → Pages → Branch を `main` / `(root)` にして Save。
3. 数分後に `https://<ユーザー名>.github.io/<リポジトリ名>/` で遊べます。

※ ボイスは fetch で読み込むため `file://` では鳴りません。公開後、または `python3 -m http.server` で確認してください。

## セリフのボイス
`assets/voice/lines/` に `キャラ名_番号.wav`（例 `sio_001.wav`）を置くと、`SERIFU.md` の同じ番号のセリフを表示するときに再生されます。
ファイルを追加・差し替えたら、`node gen_map.js` で `voicemap.js` を更新してください（gen_map.js は同梱）。

## 効果音用の声（旧）
ファイル名がランダムな文字列だったため、声の高さから **仮の割り当て**をしています。
`story.js` の `VOICE_CAST`（汐音 `sio` / 小春 `koh` / 日向 `hinata` / モブ `mob`）のファイル名を移し替えれば修正できます。タイトルの「ボイス確認」で聴き比べできます。

## 3D演出（scene3d.js）
依存ライブラリなしの WebGL です。シナリオの場面に `v3: 'corridor'`（廊下）または `v3: 'ring'`（教室で囲まれる）を書くと、その場面だけ3Dになります。
視点は PC はマウス、スマホは端末の傾きかドラッグで動かせます。WebGL が使えない環境では従来の2D演出のままです。
現在 3D の場面: 廊下 N_1 / N_2run / N_2look / N_2cover / N_2listen / X_caught / A_2 / A_2x、教室 B_5 / B_5a / B_5b / B_5c / E_silence。

## テスト用パラメータ
- `?fast=1` 演出待ち時間を短縮
- `?jump=シーンID&type=empathy|bystander|indifferent|knowledge|own` 任意のシーンから開始

## 配慮
- 注意画面とマイルドモード（点滅・揺れ・大音量を弱める）あり。
- IBS の説明は一般的な情報で、診断ではありません。
