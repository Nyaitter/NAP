# nap-cdn

NAP のパッケージを配信するサーバーです。

## 起動

```console
$ node cdn/server.js
```

追加のパッケージは要りません。Node.js と git が必要です。

| 環境変数 | 意味 | 既定 |
|---|---|---|
| PORT | 待ち受けポート | 8780 |
| NAP_CDN_DATA | データを置くフォルダ | cdn/data |
| NAP_CDN_UPSTREAM | 取り寄せ元の基底 | https://github.com |
| NAP_CDN_FETCH_INTERVAL_MS | 取り寄せの間隔。単位はミリ秒 | 30000 |
| GITHUB_TOKEN | 検索に使う GitHub のトークン | なし |

ルート / へアクセスすると、使い方を OpenAPI 形式で返します。

## ファイルの配信

```text
GET /<所有者>/<リポジトリ>/<参照>/<パス>
```

参照には、版ID、版IDとラベルを並べた形、版コード、タグやブランチの完全な名前、コミットが使えます。タグやブランチの完全な名前の例は nap/index です。

対象は NAP のリポジトリだけです。NAP のリポジトリでないときはエラーを返します。

版のファイルは長く保持されます。ブランチのファイルは60秒だけ保持されます。

接続先をこのサーバーに向けるだけで使えます。

- nap-client: createClient の rawBase にこのサーバーの URL を指定する
- CLI: 環境変数 NAP_RAW_BASE にこのサーバーの URL を設定する

```js
createClient({ rawBase: 'https://cdn.example.jp' })
```

```console
$ NAP_RAW_BASE=https://cdn.example.jp nap get Nyaitter/Client
```

## API

| メソッドとパス | 返るもの |
|---|---|
| GET /api/v1/repos/<所有者>/<リポジトリ> | パッケージの情報。宣言と版の総数と最新版 |
| GET /api/v1/repos/<所有者>/<リポジトリ>/versions | 版の一覧。版IDと版コードと出典と日時。開発中の版には印が付く |
| GET /api/v1/repos/<所有者>/<リポジトリ>/versions/<版ID> | 版の詳細。説明とマニフェスト |
| GET /api/v1/repos/<所有者>/<リポジトリ>/versions/<版ID>/archive.zip | 版の全ファイルをまとめた ZIP |
| GET /api/v1/search?q=<キーワード> | パッケージの検索結果 |
| GET /healthz | 生存確認 |

版の詳細の指定には、版IDのほか、版IDとラベルを並べた形と版コードも使えます。

検索は nap search と同じです。nap.json を持つリポジトリを探して返します。検索には GITHUB_TOKEN の設定が必要です。設定がないときは、その旨のエラーを返します。
