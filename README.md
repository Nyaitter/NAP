# NAP

リポジトリに版を付けて公開し、公開された版を取り寄せるためのツールです。

## インストール

```bash
npm install -g @nyaitter/nap
```

nap コマンドとして使えるようになります。npx からも使えます。

```console
$ npx @nyaitter/nap publish
```

ソースから使う場合は、clone したフォルダで ./install.sh を実行します。

## 使い始める

### 版を作る

リポジトリのルートに nap.json を作ります。

```console
$ nap init
```

nap.json は次の形です。

```json
{
  "name": "nyaitter-client",
  "include": ["**"],
  "composition": ["nyaitter/nyaitter.js", "nyaitter/nyaitterui", "nyaitter/nyaitterime"]
}
```

発行します。

```console
$ nap publish
```

今のコミットの内容が版になります。同じ内容で再実行しても、新しい版は作られません。

指定できるもの:

- --ref <コミット|ブランチ>: 対象のコミットを変える
- --remote <リモート>: 公開先を変える。既定は origin
- --libraries <file.json>: 一緒に使うパッケージの入手先を渡す
- --test <ラベル>: 開発中の版として発行する
- --no-push: 版を作るだけで、公開しない
- --message <説明>: 版の説明を付ける。説明は nap show で見られる

--libraries のファイルは次の形です。版を固定したいときは version に版IDを書きます。

```json
{
  "nyaitter/nyaitter.js": { "repo": "Nyaitter/Nyaitter.js", "source": "../nyaitter.js" },
  "nyaitter/nyaitterui": { "repo": "Nyaitter/NyaitterUI", "source": "../nyaitter-ui" }
}
```

### 版を取り寄せる

```console
$ nap get Nyaitter/Client
$ nap get Nyaitter/Client/<版ID>
$ nap get Nyaitter/Client/<版コード>
```

指定がなければ、最新の正式版です。取り寄せた内容は照合してから置きます。置き場所は --out <ディレクトリ> で指定できます。既定はリポジトリ名のフォルダです。一緒に使うパッケージも一緒に置かれます。

ホームの置き場所へ入れるときは --global を付けます。

```console
$ nap get Nyaitter/Client --global
```

置き場所は既定で ~/nap です。環境変数 NAP_GLOBAL_DIR で変えられます。

### プロジェクトへ導入する

nap.json のあるフォルダで、--out を付けずに実行すると導入になります。

```console
$ nap get Nyaitter/Nyaitter.js
```

パッケージは nap_modules の中に置かれ、版まで nap.json の composition に記録されます。導入したパッケージは相対パスでそのまま使えます。nap_modules は Git の追跡対象にしません。

nap get を指定なしで実行すると、記録されたものをすべて導入します。

発行するときは、記録されたパッケージが版に含まれます。版は単独で使えます。

### 取得時に実行するスクリプト

nap.json の scripts.get に、取得のあとに実行するコマンドを書けます。

```json
{
  "name": "my-project",
  "include": ["**"],
  "scripts": {
    "get": "echo $NAP_DEST に置きました"
  }
}
```

スクリプトには、置き場所のパスが NAP_DEST として渡ります。--global で入れたときは NAP_GLOBAL が 1 になります。

## 版を調べる

```console
$ nap list
$ nap show <版ID>
$ nap show <版コード>
```

nap list は版の一覧を出します。nap show は、指定がなければ最新の正式版を出します。版IDは先頭だけでも指定できます。対象は --repo <所有者>/<リポジトリ> で指定できます。

```console
$ nap list Nyaitter/Client
$ nap show Nyaitter/Client
$ nap show Nyaitter/Client/<版コード>
```

対象を省くと、このフォルダの Git リポジトリの対象になります。Git の無い環境では、対象を指定してください。

## パッケージを探す

```console
$ nap search client
```

nap.json を持つリポジトリを探します。GITHUB_TOKEN の設定が必要です。

## フォーク

```console
$ nap fork Nyaitter/Nyaitter.js
```

パッケージを手元で直したいときは nap fork を使います。元のリポジトリを複製したものが nap_modules の中に置かれ、普通の Git リポジトリとして編集できます。nap get では上書きされません。

ルートで nap publish を実行すると、フォークの今の内容が版に含まれます。フォークに変更があれば、一緒に発行するか確認します。

## 取り除く

```console
$ nap remove Nyaitter/Nyaitter.js
```

導入したパッケージと nap.json の記録を取り除きます。対象がフォークのときは、作業内容が失われるため確認します。--yes を付けると確認を省けます。

## 開発中の版

開発中の版は TestVersion と呼びます。

```console
$ nap publish --test <ラベル>
$ nap get Nyaitter/Client/<版ID>-<ラベル>
```

誰でも取得して試せますが、最新の版としては選ばれません。同じ内容を --test なしで発行すると、そのまま正式版になります。

## 非公開の版

非公開の版はありません。正式に出す前に試してもらいたいときは、開発中の版を使ってください。版そのものを非公開にしたいときは、プライベートリポジトリなど、置き場所側の仕組みを使ってください。

## 配信サーバー

既定では配信サーバー経由で取得します。ZIP で一括取得するため速くなります。GitHub から直接取得する場合は、環境変数 NAP_DIRECT を設定します。別の配信サーバーを使う場合は、環境変数 NAP_RAW_BASE にその URL を設定します。

```console
$ NAP_RAW_BASE=https://cdn.example.jp nap get Nyaitter/Client
```

## ドキュメント

- [仕様](./SPEC.md)
- [取得ライブラリ](./client/README.md)
- [配信サーバー](./cdn/README.md)
