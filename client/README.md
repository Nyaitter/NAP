# nap-client

NAP の版を取得するライブラリです。単一ファイルで、追加のパッケージは要りません。ブラウザと Node の両方で使えます。

## createClient

```js
import { createClient, createMemoryCache } from './nap-client.js';

const client = createClient({
    cache: createMemoryCache(),
});
```

指定できるもの:

- rawBase: 取得先の基底 URL。nap-cdn のような配信サーバーを使うときに指定する
- cache: get と put を持つオブジェクト。省略するとメモリ上のものになる
- fetch: 取得に使う fetch。省略すると標準の fetch を使う

取得先は、各呼び出しに渡す入手先から決まります。入手先の形は所有者とリポジトリ名を並べたもので、対象は GitHub のリポジトリです。

## listVersions

```js
const { total, entries } = await client.listVersions(repo, { latestOnly: true });
```

版の一覧を返します。戻り値は total と entries です。entries は発行順で、各件は id と commit と at と tag を持ちます。tag は正式版では null、開発中の版ではそのラベルです。開発中の版は TestVersion と呼びます。

latestOnly に true を指定すると、返る entries は最後の一まとまり分だけになります。total は全体の件数のままです。latestOnly を指定しないときは、全件が返ります。

## latestVersion

```js
const latest = await client.latestVersion(repo);
```

最新の正式版を1件返します。形は id と commit と at と tag です。tag は null です。開発中の版は対象になりません。正式版が無ければ null を返します。

## getManifest

```js
const manifest = await client.getManifest(repo, ref);
```

版のマニフェストを返します。ref は版ID、または版IDとラベルを並べた形です。ラベル付きは開発中の版を指します。内容が版IDと合わなければ例外になります。

## getManifests

```js
const manifests = await client.getManifests(repo, ref);
```

マニフェストだけを、構成員まで含めて返します。ファイルの中身は取得しません。戻り値は versionId と tag と files と libraries で、libraries の各値も同じ形です。

## fetchFile

```js
const bytes = await client.fetchFile(repo, ref, path);
```

版に属するファイル1点を取得し、バイト列を返します。照合は行わないので、呼び出し側でマニフェストと照合してください。

## parseSpec と fetchSpec と getSpecManifests

パッケージは3つの要素で指定します。所有者とリポジトリと版です。

```js
const parsed = parseSpec('Nyaitter/Client/<版ID>');
const version = await client.fetchSpec('Nyaitter/Client/<版ID>');
const manifests = await client.getSpecManifests('Nyaitter/Client/<版コード>');
```

parseSpec は指定を repo と ref と id と tag に分けます。対象は版IDだけです。fetchSpec と getSpecManifests では、版の部分に版コードも使えます。版コードは発行のときに付く短いコードです。fetchSpec は fetchVersion と同じものを返し、getSpecManifests は getManifests と同じものを返します。

## fetchVersion

```js
const version = await client.fetchVersion(repo, ref);
```

版のファイルすべてを取得します。ref は版ID、または版IDとラベルを並べた形です。開発中の版を使うときはラベルまで書きます。

第3引数に onProgress を渡すと、取得の進み具合が phase と fetched と cached と total の形で通知されます。phase は download と unpack のどちらかです。

rawBase を渡したクライアントは、配信サーバーの専用 API で版の一覧を取り、版のファイルは ZIP で一括取得します。ZIP の取得や展開に失敗したときは、ファイルごとの取得に切り替わります。ZIP の取得中は、進捗の bytes と bytesTotal に受信バイト数と全体のバイト数が入ります。

戻り値は versionId と tag と files と libraries と stats です。

- versionId: 版ID。ラベルは含まない
- tag: 正式版では null、開発中の版ではそのラベル
- files: パスとバイト列の対応。バイト列は Uint8Array
- libraries: 構成員ごとの、同じ形の戻り値
- stats: fetched と cached と total。取得した件数と、手元で済んだ件数と、全体の件数

取得したファイルはマニフェストと照合します。照合が1つでも失敗したら例外になり、一部だけの結果は返りません。構成員も同じように照合します。

## NAP-Page

nap-page.js は、ページを NAP の版で管理するライブラリです。更新の確認と、版の取得と、ブラウザへの保存をします。

```js
import { createNapPage } from './nap-page.js';

const page = createNapPage({
    source: '<所有者>/<リポジトリ>',
    rawBase: 'https://cdn.nyaitter.jp',
    currentVersionId: '<今の版ID>',
});

const { hasUpdate, latest } = await page.checkUpdate();
if (hasUpdate) {
    const result = await page.fetchVersion(latest.id);
    await page.store(result);
    await page.activate(latest.id);
}
```

source は必須です。rawBase と currentVersionId は任意です。rawBase の既定は https://cdn.nyaitter.jp です。

使える呼び出し:

- versions: 版の一覧を返す
- latest: 最新の正式版を返す
- checkUpdate: 更新があるかと最新の正式版を返す
- fetchVersion: 版を取得する
- describe: 版の説明を返す。取得できなければ空
- fetchLatest: 最新の正式版を取得する
- store: 取得した版をブラウザに保存する
- storedVersions: 保存済みの版を返す
- activate: 指定した版を有効にし、他の版の保存を消す
- cacheName: 版の保存名を返す

store はブラウザの Cache Storage を使います。使えない環境ではエラーになります。
