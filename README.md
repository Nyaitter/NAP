# NAP

Git リポジトリの内容から版を作り、公開するための道具です。版には、内容から決まる版IDが付きます。詳しい決まりは SPEC.md にあります。

## 宣言

リポジトリのルートに nap.json を置きます。

```json
{
  "name": "nyaitter-client",
  "include": ["**"],
  "composition": ["nyaitter/nyaitter.js", "nyaitter/nyaitter-ui", "nyaitter/nyaitter-ime", "nyaitter/nyaitter-human"]
}
```

宣言は nap init で作れます。

```console
$ nap init
```

## 発行

```console
$ cd <リポジトリ>
$ nap publish
```

今のコミットの内容で版を作り、公開します。同じ内容で再実行しても、新しい版は作られません。

指定できるもの:

- --ref <コミット|ブランチ>: 対象のコミットを変える
- --remote <リモート>: 公開先を変える。既定は origin
- --libraries <file.json>: 一緒に使うパッケージの入手先を渡す
- --test <ラベル>: 開発中の版として発行する
- --no-push: 版を作るだけで、公開しない
- --message <説明>: 版の説明を付ける。説明は nap show で見られる

--libraries のファイルは次の形です。

```json
{
  "nyaitter/nyaitter.js": { "repo": "Nyaitter/Nyaitter.js", "source": "../nyaitter.js" },
  "nyaitter/nyaitter-ui": { "repo": "Nyaitter/NyaitterUI", "source": "../nyaitter-ui" }
}
```

repo は入手先です。形は所有者とリポジトリ名を並べたものです。source は手元のリポジトリの場所です。版を固定したいときは version に版IDを書きます。

### 開発中の版

開発中の版は TestVersion と呼びます。誰でも取得して試せますが、最新の版としては選ばれません。使うときは版IDの後ろにラベルを付けて指定します。

```console
$ nap get Nyaitter/Client/<版ID>-<ラベル>
```

同じ内容を --test なしで発行すると、そのまま正式版になります。版IDは変わりません。

## 版を調べる

```console
$ nap list
$ nap show
$ nap show <版ID>
$ nap show <版ID>-<ラベル>
$ nap show <版コード>
```

nap list は版の一覧を出します。開発中の版にはラベルが出ます。nap show は、指定がなければ最新の正式版を出します。版IDは先頭だけでも指定できます。版コードでも指定できます。版コードは、発行のときに付く短いコードです。

## パッケージを探す

```console
$ nap search
$ nap search client
```

nap.json を持つリポジトリを探します。探すには GITHUB_TOKEN の設定が必要です。

## 取り寄せる

```console
$ nap get Nyaitter/Client
$ nap get Nyaitter/Client/<版ID>
$ nap get Nyaitter/Client/<版ID>-<ラベル>
$ nap get Nyaitter/Client/<版コード>
```

指定がなければ最新の正式版を取り寄せます。取り寄せた内容は照合してから置きます。置き場所は --out <ディレクトリ> で指定できます。既定はリポジトリ名のフォルダです。一緒に使うパッケージも一緒に置かれます。

### 導入

nap.json のあるフォルダで --out を付けずに実行すると、導入になります。

```console
$ cd <自分のプロジェクト>
$ nap get Nyaitter/Nyaitter.js
```

パッケージは nap_modules の中に置かれ、版まで nap.json の composition に記録されます。導入したパッケージは相対パスでそのまま使えます。nap_modules は Git の追跡対象にしません。残すのは nap.json の記録だけです。

nap get を指定なしで実行すると、記録されたものをすべて導入します。

発行するときは、記録されたパッケージが nap_modules の中身として版に含まれます。版は単独で使えます。

### フォーク

```console
$ nap fork Nyaitter/Nyaitter.js
```

パッケージを手元で直したいときは nap fork を使います。元のリポジトリを複製したものが nap_modules の中に置かれます。導入済みなら置き換わり、未導入なら導入されます。複製したものはフォークと呼び、普通の Git リポジトリとして編集できます。nap get では上書きされません。

ルートで nap publish を実行すると、フォークの今の内容が版に含まれます。フォークに変更があれば、一緒に発行するか確認します。

### 取り除く

```console
$ nap remove Nyaitter/Nyaitter.js
```

導入したパッケージと nap.json の記録を取り除きます。対象がフォークのときは、作業内容が失われるため確認します。--yes を付けると確認を省けます。

## 取得ライブラリ

ブラウザと Node の両方で使える取得ライブラリが client にあります。詳しくは client/README.md を見てください。

```js
import { createClient } from 'nap-client';

const client = createClient({});
const { entries } = await client.listVersions('Nyaitter/Client', { latestOnly: true });
const version = await client.fetchVersion('Nyaitter/Client', entries[entries.length - 1].id);
```

## 非公開の版

非公開の版はありません。正式に出す前に試してもらいたいときは、開発中の版を使ってください。版そのものを非公開にしたいときは、プライベートリポジトリなど、置き場所側の仕組みを使ってください。
