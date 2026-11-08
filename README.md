# Pygame Surface Hover Preview

デバッグ中に Python コード上の `pygame.Surface` 変数へマウスオーバーすると、画像プレビューを表示する VS Code 拡張機能です。

## できること

- `surface` のような変数名を Hover して Surface の画像を表示
- `self.surface` / `self.window.surface` のような属性アクセスにも対応
- 元の Surface の幅・高さ、Bitsize、縮小後のプレビューサイズを表示
- 大きな Surface は Python 側で縮小してから VS Code に転送
- Python 側の追加パッケージや常駐サーバーは不要（既存の Pygame を使用）

## 必要な環境

- Visual Studio Code 1.90 以降
- Microsoft Python 拡張機能と Python Debugger（debugpy）
- デバッグ対象の Python 環境に Pygame がインストールされていること
- Python のデバッグセッションが停止中で、Call Stack でスタックフレームが選択されていること

通常実行や `Run Without Debugging` では動作しません。

## インストール

### GitHub Releases からインストール

1. リポジトリの **Releases** ページを開き、最新リリースの `.vsix` ファイルをダウンロードします。
2. VS Code で `Ctrl+Shift+P` を押します。
3. `Extensions: Install from VSIX...` を実行します。
4. VSIX ファイルを選択します。
5. 必要に応じて VS Code を再読み込みします。

### GitHub Release の作成

`package.json` のバージョンに対応する `v` 付きタグ（例: `v0.1.3`）を push すると、GitHub Actions が拡張機能をパッケージ化し、VSIX を添付した GitHub Release を作成します。

1. `package.json` の `version` を更新し、変更をコミットして GitHub に push します。
2. そのバージョンに対応するタグを作成して push します。例: `git tag v0.1.3`、`git push origin v0.1.3`
3. Actions の完了後、リポジトリの **Releases** ページで公開内容を確認します。

### ソースから起動

1. このフォルダーを VS Code で開きます。
2. ターミナルで `npm install` を実行します。
3. `npm run compile` を実行します。
4. `F5` を押して Extension Development Host を起動します。
5. Extension Development Host 側で Pygame のプロジェクトを開いてデバッグします。

## 使い方

例えば、次のコードを用意します。

```python
import pygame as pg

pg.init()
surface = pg.Surface((240, 160), pg.SRCALPHA)
surface.fill((220, 40, 50, 255))

# この行にブレークポイントを設定
print(surface.get_size())
```

ブレークポイントで停止したら、`print(surface.get_size())` の `surface` の名前にマウスオーバーします。カーソル位置までの名前を評価するため、`surface.get_size()` のようなメソッド呼び出しの行でもSurface変数をプレビューできます。`self.surface` のような属性は、`surface` の名前にマウスオーバーしてください。

## 設定

| 設定 | 初期値 | 説明 |
|---|---:|---|
| `pygameSurfacePreview.enabled` | `true` | プレビュー機能の有効・無効 |
| `pygameSurfacePreview.maxPreviewDimension` | `384` | プレビュー画像の幅・高さの最大値 |
| `pygameSurfacePreview.maxPreviewPixels` | `32768` | 転送するプレビュー画像の最大ピクセル数（上限も32768）。デバッガーの応答サイズ制限に近づく場合はさらに縮小します |
| `pygameSurfacePreview.debuggerTypes` | `debugpy`, `python` | 対象にするデバッグアダプターの種類 |

## 制限・注意点

- デバッグが停止しており、Call Stack でスタックフレームが選択されている必要があります。
- 最初の版では、単純な変数名とドット区切りの属性アクセスのみを評価します。関数呼び出し、添字、演算式などは対象外です。
- `self.surface` のような属性アクセスでは、Python の descriptor や `__getattr__` が実行される可能性があります。
- ピクセル取得のため、デバッガーに `repl` コンテキストで評価リクエストを送り、停止中の Python プロセス内で Pygame の画像変換関数を実行します。
- 転送するプレビューは最大32,768ピクセルです。デバッガー応答が大きすぎる場合は、応答上限に収まるまで追加で縮小して再評価します。
- VS Code の Hover 内で `data:image/png;base64,...` 形式の画像が表示できることを前提にしています。VS Code のバージョンやリモート環境によって画像が表示されない場合があります。
- 大きな Surface は縮小表示されます。ピクセル単位の正確な確認や画像書き出しを目的とした機能ではありません。

## トラブルシューティング

ホバーにプレビューが表示されない場合は、修正版をコンパイルしてVSIXを作り直し、インストールしてください。VS Codeの「出力」パネルで `Pygame Surface Hover Preview` を選び、デバッグ停止中にSurface変数へホバーすると、式の抽出、選択フレーム、デバッガー評価、画像生成の診断ログが表示されます。`Evaluation failed` や `Stopped:` の行があれば、原因調査に利用できます。

## 仕組み

VS Code API の `vscode.debug.activeStackItem` から選択中の `DebugStackFrame` を取得し、その `frameId` を使って Debug Adapter Protocol の `evaluate` リクエストを送信します。Python 側で Surface 判定・縮小・RGBA 化を行い、返されたデータを拡張機能側で PNG に変換して Markdown Hover に埋め込みます。

ネットワークサーバーやバックグラウンド Python プロセスは起動しません。

## ライセンス

MIT
