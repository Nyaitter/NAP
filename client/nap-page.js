// NAP-Page: ページを NAP の版で管理するためのライブラリ。
//
// 使い方:
//   import { createNapPage } from './nap-page.js';
//   const page = createNapPage({
//       source: '<所有者>/<リポジトリ>',
//       rawBase: 'https://cdn.nyaitter.jp',   // 任意。既定はこの CDN
//       currentVersionId: '<今の版ID>',        // 任意
//   });
//   const { hasUpdate, latest } = await page.checkUpdate();
//   if (hasUpdate) {
//       const result = await page.fetchVersion(latest.id);
//       await page.store(result);       // Cache Storage へ検証済みのファイルを入れる
//       await page.activate(latest.id); // 旧い版のキャッシュを消す
//   }
//
// 取得と照合は nap-client が担う。このライブラリは、版の発見・更新確認と、
// ブラウザの Cache Storage への格納を担当する。

import { createClient } from './nap-client.js';

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
    '.gz': 'application/gzip',
};

function typeFor(filePath) {
    const dot = filePath.lastIndexOf('.');
    const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : '';
    return MIME_TYPES[ext] || 'application/octet-stream';
}

// 取得結果を、Cache Storage に置くパスの組へ平らにする。本体と構成員が対象。
function flattenInto(out, prefix, result) {
    for (const [rel, bytes] of Object.entries(result.files || {})) {
        out[prefix + rel] = bytes;
    }
    for (const [ref, lib] of Object.entries(result.libraries || {})) {
        flattenInto(out, `${prefix}nap_modules/${ref}/`, lib);
    }
}

export function createNapPage(options = {}) {
    const { source, rawBase = 'https://cdn.nyaitter.jp', client: givenClient, fetch: fetchImpl, cache } = options;
    if (!source) {
        throw new Error('source が必要です。<所有者>/<リポジトリ> の形で指定してください。');
    }
    const client = givenClient || createClient({ rawBase, fetch: fetchImpl, cache });
    let currentVersionId = options.currentVersionId || null;

    // 版の一覧。索引の順。各要素は { id, code, tag, commit, source, at, description }。
    async function versions() {
        const { entries } = await client.listVersions(source);
        return entries;
    }

    // 最新の正式版。なければ null。
    async function latest() {
        return client.latestVersion(source);
    }

    // 現在の版と最新を比べる。
    async function checkUpdate() {
        const newest = await latest();
        return {
            current: currentVersionId,
            latest: newest,
            hasUpdate: Boolean(newest && newest.id !== currentVersionId),
        };
    }

    // 版を取得して照合する。ref は版ID・版ID-ラベル・版コードのいずれか。
    async function fetchVersion(ref, options) {
        return client.fetchVersion(source, ref, options);
    }

    // 版の説明。配信サーバーの API から取得する。取得できなければ空を返す。
    async function describe(versionId) {
        try {
            const fetcher = fetchImpl || globalThis.fetch;
            if (!fetcher) return '';
            const response = await fetcher(`${rawBase}/api/repos/${source}/versions/${versionId}`);
            if (!response || !response.ok) return '';
            const data = await response.json();
            return String((data && data.description) || '').trim();
        } catch (_) {
            return '';
        }
    }

    async function fetchLatest(options) {
        const newest = await latest();
        if (!newest) {
            throw new Error(`正式版はまだありません: ${source}`);
        }
        return client.fetchVersion(source, newest.id, options);
    }

    function cacheName(versionId) {
        return `nap-page:${String(source).toLowerCase()}:${versionId}`;
    }

    // 取得結果を Cache Storage へ格納する。キーは版の中のパスそのまま
    // 構成員は nap_modules/<参照>/ の下。Service Worker からはこの
    // キャッシュを版のファイルとして参照できる。
    async function store(result, options = {}) {
        if (typeof caches === 'undefined') {
            throw new Error('Cache Storage が使えない環境です。');
        }
        const flat = {};
        flattenInto(flat, '', result);
        const storage = await caches.open(cacheName(result.versionId));
        const entries = Object.entries(flat);
        let done = 0;
        for (const [rel, bytes] of entries) {
            await storage.put(
                rel,
                new Response(bytes, { headers: { 'Content-Type': typeFor(rel) } }),
            );
            done += 1;
            if (typeof options.onProgress === 'function') {
                try {
                    options.onProgress({ done, total: entries.length });
                } catch (_) {}
            }
        }
        return cacheName(result.versionId);
    }

    // 格納済みの版IDの一覧。
    async function storedVersions() {
        if (typeof caches === 'undefined') {
            throw new Error('Cache Storage が使えない環境です。');
        }
        const prefix = `nap-page:${String(source).toLowerCase()}:`;
        const keys = await caches.keys();
        return keys
            .filter((key) => key.startsWith(prefix))
            .map((key) => key.slice(prefix.length));
    }

    // 指定した版を現在にして、他の版のキャッシュを消す。
    async function activate(versionId) {
        if (typeof caches === 'undefined') {
            throw new Error('Cache Storage が使えない環境です。');
        }
        const keep = cacheName(versionId);
        const prefix = `nap-page:${String(source).toLowerCase()}:`;
        for (const key of await caches.keys()) {
            if (key.startsWith(prefix) && key !== keep) {
                await caches.delete(key);
            }
        }
        currentVersionId = versionId;
    }

    return {
        versions,
        latest,
        checkUpdate,
        fetchVersion,
        describe,
        fetchLatest,
        store,
        storedVersions,
        activate,
        cacheName,
        get currentVersionId() {
            return currentVersionId;
        },
    };
}

export default { createNapPage };
