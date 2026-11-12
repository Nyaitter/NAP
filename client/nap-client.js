// NAP のクライアント向け取得ライブラリ。
// 索引 nap/index から版を探し、タグ先のマニフェストを取得して、
// 全ファイルのハッシュ照合と版IDの再計算が通ったときだけ完全なファイル集合を返す。
// 取得先はソースで指定し、ソースは「<所有者>/<リポジトリ>」の形。
// 既定の URL は raw.githubusercontent.com の形式でソースから導出する。
// rawBase を渡したときは、その配信サーバーの専用 API を使う。

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const ID_PATTERN = /^[0-9a-f]{64}$/;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// TestVersion のラベル。git の参照名に使える形に限る。
function validateLabel(label) {
    if (
        typeof label !== 'string' ||
        label.length < 1 ||
        label.length > 32 ||
        !LABEL_PATTERN.test(label) ||
        label.endsWith('.') ||
        label.endsWith('.lock') ||
        label.includes('..')
    ) {
        throw new Error(`ラベルが不正です: ${label}`);
    }
    return label;
}

// 「<版ID>」または「<版ID>-<ラベル>」を分解する。版IDは完全な64桁が必要。
// 16進数には - が含まれないため、最初の - で一意に分かれる。
function parseVersionRef(ref) {
    if (typeof ref !== 'string' || ref.length === 0) {
        throw new Error(`版の指定が不正です: ${ref}`);
    }
    const dash = ref.indexOf('-');
    const id = dash === -1 ? ref : ref.slice(0, dash);
    const tag = dash === -1 ? null : ref.slice(dash + 1);
    if (!ID_PATTERN.test(id)) {
        throw new Error(`版の指定が不正です: ${ref}。版IDは16進数64桁で指定してください`);
    }
    if (tag !== null) validateLabel(tag);
    return { id, tag };
}

// ソースの指定は「<所有者>/<リポジトリ>」だけ。GitHub 前提。
function isSourceSpec(source) {
    if (typeof source !== 'string') return false;
    const text = source.trim();
    if (!text) return false;
    const parts = text.split('/');
    return parts.length === 2 && parts.every((part) => part.length > 0 && !/[\s:@]/.test(part));
}

// ソースから取得先の基底 URL を導出する。既定は GitHub の raw 配信。
// rawBase を渡すと、その配信を経由する。CDN など。レイアウトは同じ形。
function rawBaseFor(source, rawBase) {
    const text = String(source || '').trim();
    if (!isSourceSpec(text)) {
        throw new Error(`ソースの指定が不正です: ${source}。<所有者>/<リポジトリ>で指定してください`);
    }
    if (rawBase) return `${String(rawBase).replace(/\/+$/, '')}/${text}`;
    return `https://raw.githubusercontent.com/${text}`;
}

// パッケージの指定は「<所有者>/<リポジトリ>/<版>」の3要素で、ブランチの指定は含まない。
// 版は「<版ID>」または「<版ID>-<ラベル>」。
export function parseSpec(spec) {
    if (typeof spec !== 'string') {
        throw new Error(`パッケージの指定が不正です: ${spec}`);
    }
    const text = spec.trim();
    const parts = text.split('/');
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
        throw new Error(`パッケージの指定が不正です: ${spec}。<所有者>/<リポジトリ>/<版>の形で指定してください`);
    }
    const { id, tag } = parseVersionRef(parts[2]);
    return { repo: `${parts[0]}/${parts[1]}`, ref: parts[2], id, tag };
}

const CODE_PATTERN = /^[0-9a-z]{3,}$/;

// 版コードの形かどうか。版IDの完全な形とは重ならない。
function isVersionCode(text) {
    if (typeof text !== 'string' || !CODE_PATTERN.test(text)) return false;
    return !/^[0-9a-f]{64}(-[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(text);
}

// 版を指すパス。配信サーバー経由では版IDそのものを使う。
// raw 配信ではタグ名で、正式版は nap/<版ID>、TestVersion は nap/<版ID>-<ラベル>。
function pathRefFor(id, tag, viaApi) {
    if (viaApi) return tag ? `${id}-${tag}` : `${id}`;
    return tag ? `nap/${id}-${tag}` : `nap/${id}`;
}

// ZIP の中央ディレクトリを読む。名前と圧縮方式と位置の表を返す。
function readZipDirectory(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    const scanStart = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= scanStart; i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd === -1) throw new Error('ZIP の終端レコードが見つかりません。');
    const count = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    const entries = [];
    for (let i = 0; i < count; i++) {
        if (view.getUint32(offset, true) !== 0x02014b50) {
            throw new Error('ZIP の中央ディレクトリが不正です。');
        }
        const method = view.getUint16(offset + 10, true);
        const size = view.getUint32(offset + 20, true);
        const nameLen = view.getUint16(offset + 28, true);
        const extraLen = view.getUint16(offset + 30, true);
        const commentLen = view.getUint16(offset + 32, true);
        const localOffset = view.getUint32(offset + 42, true);
        const name = textDecoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
        entries.push({ name, method, size, localOffset });
        offset += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

async function inflateEntry(bytes, entry) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const at = entry.localOffset;
    if (view.getUint32(at, true) !== 0x04034b50) {
        throw new Error('ZIP のローカルヘッダが不正です。');
    }
    const nameLen = view.getUint16(at + 26, true);
    const extraLen = view.getUint16(at + 28, true);
    const start = at + 30 + nameLen + extraLen;
    const compressed = bytes.subarray(start, start + entry.size);
    if (entry.method === 0) return new Uint8Array(compressed);
    if (entry.method !== 8) {
        throw new Error(`ZIP の圧縮方式に対応していません: ${entry.method}`);
    }
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('DecompressionStream が使えません。');
    }
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function compareTextBytes(a, b) {
    const ba = textEncoder.encode(a);
    const bb = textEncoder.encode(b);
    const len = Math.min(ba.length, bb.length);
    for (let i = 0; i < len; i++) {
        if (ba[i] !== bb[i]) return ba[i] - bb[i];
    }
    return ba.length - bb.length;
}

// 版IDの再計算。ファイル行と構成員行をバイト順に並べたものの SHA-256。
async function computeVersionId(files, libraries) {
    const lines = Object.entries(files).map(([rel, hash]) => `F ${rel} ${hash}`);
    for (const [ref, lib] of Object.entries(libraries)) {
        lines.push(`P ${ref} ${lib.version}`);
    }
    lines.sort(compareTextBytes);
    return sha256Hex(textEncoder.encode(`${lines.join('\n')}\n`));
}

function validateManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') {
        throw new Error('マニフェストの形式が不正です。');
    }
    const files = manifest.files || {};
    const libraries = manifest.libraries || {};
    for (const [rel, hash] of Object.entries(files)) {
        if (!ID_PATTERN.test(hash)) {
            throw new Error(`マニフェストのファイルハッシュが不正です: ${rel}`);
        }
    }
    for (const [ref, lib] of Object.entries(libraries)) {
        if (!lib || lib.name !== ref || !isSourceSpec(lib.repo) || !ID_PATTERN.test(lib.version || '')) {
            throw new Error(`マニフェストの構成員が不正です: ${ref}`);
        }
    }
    return { files, libraries };
}

// ハッシュ単位のキャッシュの単純な実装。差し替えの見本として置く。
export function createMemoryCache() {
    const map = new Map();
    return {
        async get(hash) {
            return map.has(hash) ? map.get(hash) : null;
        },
        async put(hash, bytes) {
            map.set(hash, bytes);
        },
    };
}

export function createClient({ cache, fetch: fetchImpl, rawBase } = {}) {
    const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
    const store = cache || createMemoryCache();
    const viaApi = Boolean(rawBase);

    function apiUrlFor(repo, suffix) {
        return `${String(rawBase).replace(/\/+$/, '')}/api/v1/repos/${repo}${suffix}`;
    }

    // ソースから導出した URL で取得し、応答のバイト列を返す。
    async function fetchBytes(repo, ref, filePath) {
        const url = `${rawBaseFor(repo, rawBase)}/${ref}/${filePath}`;
        let lastError = null;
        try {
            const res = await doFetch(url);
            if (res && res.ok) return new Uint8Array(await res.arrayBuffer());
            lastError = new Error(`HTTP ${res ? res.status : '?'}`);
        } catch (error) {
            lastError = error;
        }
        const error = new Error(
            `取得できませんでした: ${repo} ${ref} ${filePath}: ${lastError ? lastError.message : '不明'}`,
        );
        error.napFetchFailed = true;
        throw error;
    }

    async function fetchText(repo, ref, filePath) {
        return textDecoder.decode(await fetchBytes(repo, ref, filePath));
    }

    // 索引から版の一覧を返す。latestOnly では先頭ファイルと最後のチャンクだけを読む。
    // 各項目の tag は、正式版では null、TestVersion ではそのラベル。
    async function listVersions(repo, { latestOnly = false } = {}) {
        if (viaApi) {
            try {
                const res = await doFetch(apiUrlFor(repo, '/versions'));
                if (res && res.ok) {
                    const data = await res.json();
                    const list = Array.isArray(data) ? data : data.versions || [];
                    const entries = list.map((entry) => ({
                        id: entry.id,
                        commit: entry.commit,
                        at: entry.at,
                        tag: entry.tag || null,
                        code: entry.code || null,
                        source: entry.source || null,
                        description: entry.description || '',
                    }));
                    return { total: entries.length, entries };
                }
            } catch (_) {}
        }
        const head = JSON.parse(await fetchText(repo, 'nap/index', 'index.json'));
        const defs = latestOnly ? head.chunks.slice(-1) : head.chunks;
        const entries = [];
        for (const def of defs) {
            const list = JSON.parse(await fetchText(repo, 'nap/index', def.file));
            for (const entry of list) {
                entries.push({
                    id: entry.id,
                    commit: entry.commit,
                    at: entry.at,
                    tag: entry.tag || null,
                    code: entry.code || null,
                });
            }
        }
        return { total: head.total, entries };
    }

    // 最新の正式版を返す。TestVersion は対象にしない。正式版が無ければ null。
    // 後ろのチャンクから順に読み、正式版が見つかった時点で止める。
    async function latestVersion(repo) {
        if (viaApi) {
            const { entries } = await listVersions(repo);
            for (let i = entries.length - 1; i >= 0; i--) {
                if (!entries[i].tag) {
                    return { id: entries[i].id, commit: entries[i].commit, at: entries[i].at, tag: null };
                }
            }
            return null;
        }
        const head = JSON.parse(await fetchText(repo, 'nap/index', 'index.json'));
        for (let i = head.chunks.length - 1; i >= 0; i--) {
            const list = JSON.parse(await fetchText(repo, 'nap/index', head.chunks[i].file));
            for (let j = list.length - 1; j >= 0; j--) {
                if (!list[j].tag) {
                    return { id: list[j].id, commit: list[j].commit, at: list[j].at, tag: null };
                }
            }
        }
        return null;
    }

    async function fetchManifest(repo, versionId, tag, stats) {
        const text = await fetchText(repo, pathRefFor(versionId, tag, viaApi), 'version-manifest.json');
        if (stats) stats.fetched += 1;
        let raw;
        try {
            raw = JSON.parse(text);
        } catch {
            throw new Error('マニフェストが JSON として読めません。');
        }
        const manifest = validateManifest(raw);
        const recomputed = await computeVersionId(manifest.files, manifest.libraries);
        if (recomputed !== versionId) {
            throw new Error(`版IDが一致しません: タグ ${versionId} / 再計算 ${recomputed}`);
        }
        return manifest;
    }

    // タグ先のマニフェストを取得し、版IDを再計算してタグと一致することを確かめる。
    // ref は「<版ID>」または「<版ID>-<ラベル>」。
    async function getManifest(repo, ref) {
        const { id, tag } = await resolveRef(repo, ref);
        return fetchManifest(repo, id, tag, null);
    }

    // 版の完全なファイル集合を取得する。構成員は、そのリポジトリから同じ手順でたどる。
    // 照合が1つでも失敗したら例外にし、部分的な結果は返さない。
    // 構成員は版IDで固定されている。正式版のタグで取得できない場合は、
    // 索引で同じ版IDの TestVersion を探して取得する。固定は明示指定のため。
    // ref が版コードなら、索引から版IDへ解決する。
    async function resolveRef(repo, ref) {
        if (!isVersionCode(ref)) return parseVersionRef(ref);
        const { entries } = await listVersions(repo);
        const hit = entries.find((entry) => entry.code === ref);
        if (!hit) throw new Error(`版コードが見つかりません: ${ref}`);
        return { id: hit.id, tag: hit.tag };
    }

    function notifyProgress(stats) {
        if (!stats || typeof stats.onProgress !== 'function') return;
        try {
            stats.onProgress({
                phase: stats.phase || 'download',
                fetched: stats.fetched,
                cached: stats.cached,
                total: stats.total || 0,
                bytes: stats.byteFetched || 0,
                bytesTotal: stats.byteTotal || 0,
            });
        } catch (_) {}
    }

    // 版のファイルを ZIP で一括取得する。配信サーバー経由のときだけ使う。
    // 進捗は download が受信バイト数、unpack が展開したファイル数で進む。
    async function fetchPackageFilesViaZip(repo, versionId, tag, manifest, stats) {
        const ref = pathRefFor(versionId, tag, true);
        const res = await doFetch(apiUrlFor(repo, `/versions/${ref}/archive.zip`));
        if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : '?'}`);
        let bytes;
        if (res.body && typeof res.body.getReader === 'function') {
            const reader = res.body.getReader();
            const chunks = [];
            let received = 0;
            const lengthHeader =
                res.headers && typeof res.headers.get === 'function'
                    ? Number(res.headers.get('content-length')) || 0
                    : 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                received += value.length;
                if (stats) {
                    stats.phase = 'download';
                    stats.byteFetched = received;
                    stats.byteTotal = lengthHeader;
                    notifyProgress(stats);
                }
            }
            bytes = new Uint8Array(received);
            let at = 0;
            for (const chunk of chunks) {
                bytes.set(chunk, at);
                at += chunk.length;
            }
        } else {
            bytes = new Uint8Array(await res.arrayBuffer());
        }
        const byName = new Map(readZipDirectory(bytes).map((entry) => [entry.name, entry]));
        const names = Object.keys(manifest.files);
        const files = {};
        let done = 0;
        for (const rel of names) {
            const entry = byName.get(rel);
            if (!entry) throw new Error(`ZIP にファイルがありません: ${rel}`);
            const data = await inflateEntry(bytes, entry);
            const actual = await sha256Hex(data);
            if (actual !== manifest.files[rel]) {
                throw new Error(`照合に失敗しました: ${rel}`);
            }
            await store.put(manifest.files[rel], data);
            files[rel] = data;
            done += 1;
            if (stats) {
                stats.phase = 'unpack';
                stats.fetched = done;
                stats.total = names.length;
                notifyProgress(stats);
            }
        }
        if (stats) stats.phase = 'download';
        return files;
    }

    async function fetchPackage(repo, versionId, tag, stats, fallbackToTest) {
        let manifest;
        try {
            manifest = await fetchManifest(repo, versionId, tag, stats);
        } catch (error) {
            if (!fallbackToTest || !error || error.napFetchFailed !== true) throw error;
            const { entries } = await listVersions(repo);
            const hit = entries.find((entry) => entry.id === versionId && entry.tag);
            if (!hit) throw error;
            return fetchPackage(repo, versionId, hit.tag, stats, false);
        }
        let files = null;
        if (viaApi) {
            try {
                files = await fetchPackageFilesViaZip(repo, versionId, tag, manifest, stats);
            } catch (_) {
                files = null;
            }
        }
        if (!files) {
            if (stats) {
                stats.phase = 'download';
                stats.total = (stats.total || 0) + Object.keys(manifest.files).length;
                notifyProgress(stats);
            }
            files = {};
            for (const rel of Object.keys(manifest.files).sort(compareTextBytes)) {
            const expected = manifest.files[rel];
            const hit = await store.get(expected);
            if (hit) {
                files[rel] = hit;
                stats.cached += 1;
                notifyProgress(stats);
                continue;
            }
            const bytes = await fetchBytes(repo, pathRefFor(versionId, tag, viaApi), rel);
            const actual = await sha256Hex(bytes);
            if (actual !== expected) {
                throw new Error(
                    `照合に失敗しました: ${rel}。期待 ${expected} / 実際 ${actual}`,
                );
            }
            await store.put(expected, bytes);
            files[rel] = bytes;
            stats.fetched += 1;
            notifyProgress(stats);
            }
        }
        const libraries = {};
        for (const ref of Object.keys(manifest.libraries).sort(compareTextBytes)) {
            const lib = manifest.libraries[ref];
            libraries[ref] = await fetchPackage(lib.repo, lib.version, null, stats, true);
        }
        return { versionId, tag, manifest, files, libraries };
    }

    // マニフェストだけを再帰的に取得する。ファイルのバイト列は取得しない。
    // 構成員の固定解決は fetchVersion と同じで、正式版で取得できない場合は
    // 索引の TestVersion からたどる。
    async function fetchManifests(repo, versionId, tag, fallbackToTest) {
        let manifest;
        try {
            manifest = await fetchManifest(repo, versionId, tag, null);
        } catch (error) {
            if (!fallbackToTest || !error || error.napFetchFailed !== true) throw error;
            const { entries } = await listVersions(repo);
            const hit = entries.find((entry) => entry.id === versionId && entry.tag);
            if (!hit) throw error;
            return fetchManifests(repo, versionId, hit.tag, false);
        }
        const libraries = {};
        for (const ref of Object.keys(manifest.libraries).sort(compareTextBytes)) {
            const lib = manifest.libraries[ref];
            libraries[ref] = await fetchManifests(lib.repo, lib.version, null, true);
        }
        return { versionId, tag, files: manifest.files, libraries };
    }

    async function getManifests(repo, ref) {
        const { id, tag } = await resolveRef(repo, ref);
        return fetchManifests(repo, id, tag, false);
    }

    // 版に属するファイル1点をソースから取得する。照合は呼び出し側で行う。
    async function fetchFile(repo, ref, filePath) {
        const { id, tag } = await resolveRef(repo, ref);
        return fetchBytes(repo, pathRefFor(id, tag, viaApi), filePath);
    }

    // ref は「<版ID>」または「<版ID>-<ラベル>」。TestVersion を使うときは明示指定する。
    async function fetchVersion(repo, ref, options) {
        const { id, tag } = await resolveRef(repo, ref);
        const stats = { fetched: 0, cached: 0, total: 0, onProgress: options && options.onProgress };
        const result = await fetchPackage(repo, id, tag, stats, false);
        return { ...result, stats };
    }

    // 指定をソースと版の参照に分ける。版の参照は版IDでも版コードでもよい。
    function splitSpec(spec) {
        if (typeof spec !== 'string') {
            throw new Error(`パッケージの指定が不正です: ${spec}`);
        }
        const parts = spec.trim().split('/');
        if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
            throw new Error(`パッケージの指定が不正です: ${spec}。<所有者>/<リポジトリ>/<版>の形で指定してください`);
        }
        return { repo: `${parts[0]}/${parts[1]}`, ref: parts[2] };
    }

    // ソースと版の指定で版を取得する。指定は「<所有者>/<リポジトリ>/<版>」の形。
    async function fetchSpec(spec) {
        const { repo, ref } = splitSpec(spec);
        return fetchVersion(repo, ref);
    }

    async function getSpecManifests(spec) {
        const { repo, ref } = splitSpec(spec);
        return getManifests(repo, ref);
    }

    return {
        listVersions,
        latestVersion,
        getManifest,
        getManifests,
        fetchVersion,
        fetchFile,
        fetchSpec,
        getSpecManifests,
    };
}

if (typeof globalThis !== 'undefined') {
    globalThis.NapClient = { createClient, createMemoryCache, parseSpec };
}

export default { createClient, createMemoryCache, parseSpec };
