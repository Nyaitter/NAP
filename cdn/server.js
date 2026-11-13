'use strict';

// NAP 専用の軽量 CDN。パッケージのリポジトリを git mirror として手元に持ち、
// 版のファイル配信と、NAP の取り寄せ・検索のための REST API を提供する。
//
// 環境変数:
//   PORT                    待ち受けポート。既定は 8780
//   NAP_CDN_DATA            mirror を置くフォルダ。既定は ./data
//   NAP_CDN_UPSTREAM        取り寄せ元の基底。既定は https://github.com
//   NAP_CDN_FETCH_INTERVAL_MS  ブランチ再検証の最小間隔。既定は 30000

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const PORT = Number(process.env.PORT || 8780);
const DATA_DIR = process.env.NAP_CDN_DATA || path.join(__dirname, 'data');
const UPSTREAM = (process.env.NAP_CDN_UPSTREAM || 'https://github.com').replace(/\/+$/, '');
const FETCH_INTERVAL_MS = Number(process.env.NAP_CDN_FETCH_INTERVAL_MS || 30000);
const MISS_FETCH_INTERVAL_MS = 5000;

const REPOS_DIR = path.join(DATA_DIR, 'repos');
fs.mkdirSync(REPOS_DIR, { recursive: true });
const ARCHIVES_DIR = path.join(DATA_DIR, 'archives');
fs.mkdirSync(ARCHIVES_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{64}(-[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const CODE_PATTERN = /^[0-9a-z]{3,}$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
    '.gz': 'application/gzip',
    '.bin': 'application/octet-stream',
};


// ルートで返す OpenAPI 文書。
const OPENAPI = {
    openapi: '3.0.3',
    info: {
        title: 'nap-cdn',
        version: '1.0.0',
        description:
            'NAP の配信サーバーです。',
    },
    servers: [{ url: '/' }],
    paths: {
        '/': {
            get: {
                summary: '使い方',
                operationId: 'getUsage',
                responses: {
                    '200': {
                        description: 'この OpenAPI 文書',
                        content: { 'application/json': { schema: { type: 'object' } } },
                    },
                },
            },
        },
        '/healthz': {
            get: {
                summary: '生存確認',
                operationId: 'getHealth',
                responses: {
                    '200': {
                        description: 'ok と返ります',
                        content: { 'text/plain': { schema: { type: 'string' } } },
                    },
                },
            },
        },
        '/api/spec': {
            get: {
                summary: '仕様書',
                operationId: 'getSpec',
                responses: {
                    '200': {
                        description: 'この OpenAPI 文書',
                        content: { 'application/json': { schema: { type: 'object' } } },
                    },
                },
            },
        },
        '/api/repos/{owner}/{repo}': {
            get: {
                summary: 'パッケージの情報',
                operationId: 'getRepo',
                parameters: [
                    { name: 'owner', in: 'path', required: true, schema: { type: 'string' }, description: '所有者。GitHub のユーザー名または組織名' },
                    { name: 'repo', in: 'path', required: true, schema: { type: 'string' }, description: 'リポジトリ名' },
                ],
                responses: {
                    '200': {
                        description: '宣言・版の総数・最新版',
                        content: { 'application/json': { schema: { $ref: '#/components/schemas/RepoInfo' } } },
                    },
                    '404': { $ref: '#/components/responses/NotFound' },
                },
            },
        },
        '/api/repos/{owner}/{repo}/versions': {
            get: {
                summary: '版の一覧',
                operationId: 'listVersions',
                parameters: [
                    { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
                    { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
                    { name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 30, maximum: 100 }, description: '一度に返す数' },
                    { name: 'cursor', in: 'query', required: false, schema: { type: 'string' }, description: '続きを取得するための位置。前の応答の next_cursor' },
                ],
                responses: {
                    '200': {
                        description: '新しい順の版の一覧',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    required: ['versions', 'has_next', 'next_cursor'],
                                    properties: {
                                        versions: {
                                            type: 'array',
                                            items: { $ref: '#/components/schemas/VersionEntry' },
                                        },
                                        has_next: { type: 'boolean' },
                                        next_cursor: { type: 'string', nullable: true },
                                    },
                                },
                            },
                        },
                    },
                    '404': { $ref: '#/components/responses/NotFound' },
                },
            },
        },
        '/api/repos/{owner}/{repo}/versions/{ref}': {
            get: {
                summary: '版の詳細',
                operationId: 'getVersion',
                parameters: [
                    { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
                    { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
                    {
                        name: 'ref',
                        in: 'path',
                        required: true,
                        schema: { type: 'string' },
                        description: '版ID、「版ID-ラベル」、版コードのいずれか',
                    },
                ],
                responses: {
                    '200': {
                        description: '版の説明とマニフェストを含む詳細',
                        content: { 'application/json': { schema: { $ref: '#/components/schemas/VersionDetail' } } },
                    },
                    '404': { $ref: '#/components/responses/NotFound' },
                },
            },
        },
        '/api/repos/{owner}/{repo}/versions/{ref}/archive.zip': {
            get: {
                summary: '版の ZIP',
                operationId: 'getVersionArchive',
                parameters: [
                    { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
                    { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
                    {
                        name: 'ref',
                        in: 'path',
                        required: true,
                        schema: { type: 'string' },
                        description: '版ID、「版ID-ラベル」、版コードのいずれか',
                    },
                ],
                responses: {
                    '200': {
                        description: '版の全ファイルをまとめた ZIP',
                        content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } },
                    },
                    '404': { $ref: '#/components/responses/NotFound' },
                },
            },
        },
        '/api/search': {
            get: {
                summary: 'パッケージの検索',
                operationId: 'searchPackages',
                parameters: [
                    { name: 'q', in: 'query', required: false, schema: { type: 'string' }, description: 'キーワード。空白区切りで複数指定可' },
                    { name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 20, maximum: 100 } },
                ],
                responses: {
                    '200': {
                        description: '一致したパッケージの一覧',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    required: ['packages', 'total', 'has_next'],
                                    properties: {
                                        packages: {
                                            type: 'array',
                                            items: { $ref: '#/components/schemas/SearchResult' },
                                        },
                                        total: { type: 'integer', description: '候補の総数' },
                                        has_next: { type: 'boolean' },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
        '/{owner}/{repo}/{path}': {
            get: {
                summary: 'ファイルの配信',
                operationId: 'getFile',
                parameters: [
                    { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
                    { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
                    {
                        name: 'path',
                        in: 'path',
                        required: true,
                        schema: { type: 'string' },
                        description: '「<参照>/<ファイルのパス>」。参照は版ID、「版ID-ラベル」、版コード、タグやブランチの完全な名前、コミットのいずれか。完全な名前はたとえば nap-index',
                    },
                ],
                responses: {
                    '200': {
                        description: 'ファイルの内容',
                        content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
                    },
                    '404': { $ref: '#/components/responses/NotFound' },
                },
            },
        },
    },
    components: {
        responses: {
            NotFound: {
                description: '見つかりません',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
        },
        schemas: {
            Error: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
            },
            VersionEntry: {
                type: 'object',
                required: ['id', 'code', 'tag', 'test', 'commit', 'source', 'created_at'],
                properties: {
                    id: { type: 'string', description: '版ID' },
                    code: { type: 'string', nullable: true, description: '版コード' },
                    tag: { type: 'string', nullable: true, description: '開発中の版のラベル。正式版は null' },
                    test: { type: 'boolean', description: '開発中の版かどうか' },
                    commit: { type: 'string', description: '版の専用コミット' },
                    source: { type: 'string', nullable: true, description: '出典コミット' },
                    created_at: { type: 'string', format: 'date-time', description: '発行日時' },
                    description: { type: 'string', description: '版の説明' },
                },
            },
            VersionDetail: {
                allOf: [
                    { $ref: '#/components/schemas/VersionEntry' },
                    {
                        type: 'object',
                        required: ['repo', 'description', 'manifest'],
                        properties: {
                            repo: { type: 'string' },
                            description: { type: 'string', description: '版の説明' },
                            manifest: {
                                nullable: true,
                                type: 'object',
                                properties: {
                                    files: {
                                        type: 'object',
                                        description: 'ファイルのパスと、その内容の SHA-256',
                                        additionalProperties: { type: 'string' },
                                    },
                                    libraries: {
                                        type: 'object',
                                        description: '構成員',
                                        additionalProperties: { type: 'object' },
                                    },
                                    sizes: {
                                        type: 'object',
                                        description: 'ファイルのパスとバイト数',
                                        additionalProperties: { type: 'integer' },
                                    },
                                },
                            },
                        },
                    },
                ],
            },
            RepoInfo: {
                type: 'object',
                required: ['repo', 'name', 'description', 'declaration', 'version_count', 'latest'],
                properties: {
                    repo: { type: 'string' },
                    name: { type: 'string', description: 'パッケージ名' },
                    description: { type: 'string' },
                    declaration: { type: 'object', nullable: true, description: 'nap.json の内容' },
                    version_count: { type: 'integer', description: '版の総数' },
                    latest: { $ref: '#/components/schemas/VersionEntry', nullable: true },
                },
            },
            SearchResult: {
                type: 'object',
                required: ['repo', 'name', 'description', 'member_count'],
                properties: {
                    repo: { type: 'string' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    member_count: { type: 'integer', description: '構成員の数' },
                },
            },
        },
    },
};

function git(args, cwd) {
    return new Promise((resolve, reject) => {
        execFile(
            'git',
            args,
            { cwd, maxBuffer: 64 * 1024 * 1024 },
            (error, stdout, stderr) => {
                if (error) {
                    error.stderr = stderr;
                    reject(error);
                } else {
                    resolve(stdout);
                }
            },
        );
    });
}

async function gitText(args, cwd) {
    const out = await git(args, cwd);
    return out.toString('utf8').trim();
}

async function gitOk(args, cwd) {
    try {
        await git(args, cwd);
        return true;
    } catch {
        return false;
    }
}

// ---- リポジトリの管理 ----

const repoLocks = new Map();
function withRepoLock(key, fn) {
    const prev = repoLocks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    repoLocks.set(
        key,
        next.catch(() => {}),
    );
    return next;
}

const lastFetchAt = new Map();
const lastMissFetchAt = new Map();

function repoKey(owner, repo) {
    return `${owner}/${repo}`.toLowerCase();
}

function repoDir(owner, repo) {
    return path.join(REPOS_DIR, owner.toLowerCase(), `${repo.toLowerCase()}.git`);
}

async function ensureRepo(owner, repo) {
    const key = repoKey(owner, repo);
    const dir = repoDir(owner, repo);
    if (fs.existsSync(path.join(dir, 'HEAD'))) return dir;
    return withRepoLock(key, async () => {
        if (fs.existsSync(path.join(dir, 'HEAD'))) return dir;
        const tmp = `${dir}.tmp-${process.pid}`;
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        await git(['clone', '--mirror', '--quiet', `${UPSTREAM}/${owner}/${repo}.git`, tmp]);
        fs.renameSync(tmp, dir);
        lastFetchAt.set(key, Date.now());
        declarationCache.delete(dir);
        return dir;
    });
}

async function fetchRepo(owner, repo, { miss = false, wait = true } = {}) {
    const key = repoKey(owner, repo);
    const dir = repoDir(owner, repo);
    const now = Date.now();
    const table = miss ? lastMissFetchAt : lastFetchAt;
    const interval = miss ? MISS_FETCH_INTERVAL_MS : FETCH_INTERVAL_MS;
    if (now - (table.get(key) || 0) < interval) return;
    table.set(key, now);
    const job = withRepoLock(key, async () => {
        try {
            await git(['fetch', '--prune', '--quiet', 'origin'], dir);
            lastFetchAt.set(key, Date.now());
            declarationCache.delete(dir);
        } catch {
            // 取り寄せに失敗しても、手元の内容で配信を続ける。
        }
    });
    if (wait) await job;
    else job.catch(() => {});
}

// ---- 索引と宣言 ----

const indexCache = new Map();

async function readIndex(dir) {
    let headSha = null;
    try {
        headSha = await gitText(['rev-parse', '--verify', '--quiet', 'refs/tags/nap-index'], dir);
    } catch {
        try {
            headSha = await gitText(['rev-parse', '--verify', '--quiet', 'refs/heads/nap/index'], dir);
        } catch {
            return { entries: [], headSha: null };
        }
    }
    const cached = indexCache.get(dir);
    if (cached && cached.headSha === headSha) return cached;
    const head = JSON.parse(await gitText(['show', `${headSha}:index.json`], dir));
    const entries = [];
    for (const chunk of head.chunks || []) {
        const part = JSON.parse(await gitText(['show', `${headSha}:${chunk.file}`], dir));
        if (Array.isArray(part)) entries.push(...part);
    }
    const result = { entries, headSha };
    indexCache.set(dir, result);
    return result;
}

const declarationCache = new Map();

// 宣言。取り寄せで内容が変わるまで保持する。
async function readDeclaration(dir) {
    if (declarationCache.has(dir)) return declarationCache.get(dir);
    let doc = null;
    try {
        const headRef = await gitText(['symbolic-ref', '--quiet', 'HEAD'], dir);
        const text = await gitText(['show', `${headRef}:nap.json`], dir);
        const parsed = JSON.parse(text);
        doc = parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        doc = null;
    }
    declarationCache.set(dir, doc);
    return doc;
}

// NAP のリポジトリかどうか。宣言か版があればよい。
async function isNapRepo(dir) {
    if (await readDeclaration(dir)) return true;
    const { entries } = await readIndex(dir);
    return entries.length > 0;
}

const descriptionCache = new Map();

// 版の説明。専用コミットの本文がそのまま説明になる。コミットは変わらないため保持する。
async function versionDescription(dir, entry) {
    if (descriptionCache.has(entry.commit)) {
        return descriptionCache.get(entry.commit);
    }
    let description = '';
    try {
        description = (await gitText(['log', '-1', '--format=%b', entry.commit], dir)).trim();
    } catch {
        return '';
    }
    descriptionCache.set(entry.commit, description);
    return description;
}

async function presentEntryWithDescription(dir, entry, style) {
    return { ...presentEntry(entry, style), description: await versionDescription(dir, entry) };
}

function presentEntry(entry, style) {
    const presented = {
        id: entry.id,
        code: entry.code || null,
        tag: entry.tag || null,
        test: Boolean(entry.tag),
        commit: entry.commit,
        source: entry.source || null,
    };
    if (style === 'api') presented.created_at = entry.at;
    else presented.at = entry.at;
    return presented;
}

function latestOf(entries) {
    let latest = null;
    for (const entry of entries) {
        if (!entry.tag) latest = entry;
    }
    return latest;
}

// ---- 参照の解決 ----

async function revParseCommit(dir, ref) {
    try {
        return await gitText(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], dir);
    } catch {
        return null;
    }
}

// refText をコミットへ解決する。immutable はタグ・コミット・版ID・版コード由来。
async function resolveRef(dir, refText) {
    if (!refText || refText.includes('..')) return null;
    // タグ・ブランチの完全な名前
    for (const candidate of [`refs/tags/${refText}`, `refs/heads/${refText}`]) {
        const commit = await revParseCommit(dir, candidate);
        if (commit) {
            return { commit, immutable: candidate.startsWith('refs/tags/') };
        }
    }
    // 版ID または ID-ラベル
    if (ID_PATTERN.test(refText)) {
        const commit = await revParseCommit(dir, `refs/tags/nap/${refText}`);
        if (commit) return { commit, immutable: true };
    }
    // 版コード
    if (CODE_PATTERN.test(refText) && !ID_PATTERN.test(refText)) {
        const { entries } = await readIndex(dir);
        const hit = entries.find((entry) => entry.code === refText);
        if (hit) {
            const tag = `nap/${hit.id}${hit.tag ? `-${hit.tag}` : ''}`;
            const commit = await revParseCommit(dir, `refs/tags/${tag}`);
            if (commit) return { commit, immutable: true };
        }
    }
    // コミット SHA そのもの
    if (/^[0-9a-f]{7,64}$/.test(refText)) {
        const commit = await revParseCommit(dir, refText);
        if (commit) return { commit, immutable: true };
    }
    return null;
}

async function isBranchRef(dir, refText) {
    return Boolean(await revParseCommit(dir, `refs/heads/${refText}`));
}

function validFilePath(filePath) {
    if (!filePath || filePath.startsWith('/') || filePath.includes('\\')) return false;
    return filePath.split('/').every((seg) => seg !== '..' && seg !== '');
}

// ---- 応答 ----

function sendJson(res, status, body, cacheControl) {
    const text = `${JSON.stringify(body, null, 2)}\n`;
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': cacheControl || 'no-store',
    });
    res.end(text);
}

function sendError(res, status, message) {
    sendJson(res, status, { error: message });
}

async function serveFile(req, res, dir, resolved, filePath) {
    const target = `${resolved.commit}:${filePath}`;
    if (!(await gitOk(['cat-file', '-e', target], dir))) {
        sendError(res, 404, 'ファイルが見つかりません');
        return;
    }
    const size = Number(await gitText(['cat-file', '-s', target], dir));
    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': size,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': resolved.immutable
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=60',
    });
    if (req.method === 'HEAD') {
        res.end();
        return;
    }
    const child = spawn('git', ['-C', dir, 'cat-file', 'blob', target], {
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.stdout.pipe(res);
    child.on('error', () => res.destroy());
}

// ---- ルーティング ----

async function handleRaw(req, res, owner, repo, rest) {
    const dir = await ensureRepo(owner, repo);
    if (!(await isNapRepo(dir))) {
        await fetchRepo(owner, repo, { miss: true });
        if (!(await isNapRepo(dir))) {
            sendError(res, 404, 'NAP のリポジトリではありません');
            return;
        }
    }
    // 参照は最大で残りの全て、最小で1要素。長い参照から順に試す。
    for (let k = rest.length - 1; k >= 1; k--) {
        const refText = rest.slice(0, k).join('/');
        const filePath = rest.slice(k).join('/');
        if (!validFilePath(filePath)) continue;
        let resolved = await resolveRef(dir, refText);
        if (resolved && !resolved.immutable) {
            await fetchRepo(owner, repo);
            resolved = (await resolveRef(dir, refText)) || resolved;
        }
        if (!resolved) continue;
        await serveFile(req, res, dir, resolved, filePath);
        return;
    }
    // どの参照でも解決できなければ、未取り寄せの可能性があるので1回だけ取り寄せて再試行。
    await fetchRepo(owner, repo, { miss: true });
    for (let k = rest.length - 1; k >= 1; k--) {
        const refText = rest.slice(0, k).join('/');
        const filePath = rest.slice(k).join('/');
        if (!validFilePath(filePath)) continue;
        const resolved = await resolveRef(dir, refText);
        if (!resolved) continue;
        await serveFile(req, res, dir, resolved, filePath);
        return;
    }
    sendError(res, 404, '見つかりません');
}

async function handleRepoInfo(req, res, owner, repo, style) {
    const dir = await ensureRepo(owner, repo);
    await fetchRepo(owner, repo, { wait: false });
    if (!(await isNapRepo(dir))) {
        sendError(res, 404, 'NAP のリポジトリではありません');
        return;
    }
    const declaration = await readDeclaration(dir);
    const { entries } = await readIndex(dir);
    const latest = latestOf(entries);
    sendJson(
        res,
        200,
        {
            repo: `${owner}/${repo}`,
            name: declaration && declaration.name ? declaration.name : repo.toLowerCase(),
            description:
                declaration && typeof declaration.description === 'string'
                    ? declaration.description
                    : '',
            declaration,
            ...(style === 'api'
                ? { version_count: entries.length }
                : { versions: entries.length }),
            latest: latest ? await presentEntryWithDescription(dir, latest, style) : null,
        },
        'public, max-age=60',
    );
}

async function handleVersions(req, res, owner, repo, style, url) {
    const dir = await ensureRepo(owner, repo);
    await fetchRepo(owner, repo, { wait: false });
    if (!(await isNapRepo(dir))) {
        sendError(res, 404, 'NAP のリポジトリではありません');
        return;
    }
    const { entries } = await readIndex(dir);
    if (style !== 'api') {
        const latest = latestOf(entries);
        sendJson(
            res,
            200,
            {
                repo: `${owner}/${repo}`,
                latest: latest ? latest.id : null,
                versions: await Promise.all(
                    entries.map((entry) => presentEntryWithDescription(dir, entry, style)),
                ),
            },
            'public, max-age=60',
        );
        return;
    }
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 30, 1), 100);
    const cursor = url.searchParams.get('cursor');
    const ordered = [...entries].reverse();
    let start = 0;
    if (cursor) {
        const at = ordered.findIndex((entry) => entry.id === cursor);
        if (at >= 0) start = at + 1;
    }
    const page = ordered.slice(start, start + limit);
    const hasNext = start + page.length < ordered.length;
    sendJson(
        res,
        200,
        {
            versions: await Promise.all(
                page.map((entry) => presentEntryWithDescription(dir, entry, style)),
            ),
            has_next: hasNext,
            next_cursor: hasNext && page.length > 0 ? page[page.length - 1].id : null,
        },
        'public, max-age=60',
    );
}

async function handleVersionDetail(req, res, owner, repo, refText, style) {
    const dir = await ensureRepo(owner, repo);
    await fetchRepo(owner, repo, { wait: false });
    if (!(await isNapRepo(dir))) {
        sendError(res, 404, 'NAP のリポジトリではありません');
        return;
    }
    const { entries } = await readIndex(dir);
    const entry = resolveEntry(entries, refText);
    if (!entry) {
        sendError(res, 404, '版が見つかりません');
        return;
    }
    const manifest = await versionManifest(dir, entry);
    const description = await versionDescription(dir, entry);
    sendJson(
        res,
        200,
        {
            repo: `${owner}/${repo}`,
            ...presentEntry(entry, style),
            description,
            manifest,
        },
        'public, max-age=31536000, immutable',
    );
}

const manifestCache = new Map();

// 版のマニフェストと各ファイルの大きさ。版は不変なので保持する。
async function versionManifest(dir, entry) {
    if (manifestCache.has(entry.commit)) return manifestCache.get(entry.commit);
    let manifest = null;
    try {
        manifest = JSON.parse(
            await gitText(['show', `${entry.commit}:version-manifest.json`], dir),
        );
    } catch {
        manifest = null;
    }
    if (manifest && manifest.files) {
        try {
            const tree = await gitText(['ls-tree', '-r', '-l', '-z', entry.commit], dir);
            const sizes = {};
            for (const record of tree.split('\0')) {
                const match = /^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/.exec(record);
                if (match && Object.prototype.hasOwnProperty.call(manifest.files, match[2])) {
                    sizes[match[2]] = Number(match[1]);
                }
            }
            manifest.sizes = sizes;
        } catch {}
    }
    if (manifestCache.size >= 256) {
        manifestCache.delete(manifestCache.keys().next().value);
    }
    manifestCache.set(entry.commit, manifest);
    return manifest;
}

function resolveEntry(entries, refText) {
    let entry = null;
    if (ID_PATTERN.test(refText)) {
        const [id, ...labelParts] = refText.split('-');
        const label = labelParts.length ? labelParts.join('-') : null;
        entry = entries.find((e) => e.id === id && (e.tag || null) === label) || null;
        if (!entry) entry = entries.find((e) => e.id === refText) || null;
    }
    if (!entry && CODE_PATTERN.test(refText)) {
        entry = entries.find((e) => e.code === refText) || null;
    }
    if (!entry) entry = entries.find((e) => e.id === refText) || null;
    return entry;
}

const archiveJobs = new Map();

// 版の ZIP を作ってキャッシュする。版は不変なので、コミットごとに1回だけ作る。
async function ensureArchiveFile(dir, entry) {
    const target = path.join(ARCHIVES_DIR, `${entry.commit}.zip`);
    try {
        await fs.promises.access(target);
        return target;
    } catch (_) {}
    if (!archiveJobs.has(entry.commit)) {
        const job = (async () => {
            const tmp = `${target}.tmp`;
            await new Promise((resolve, reject) => {
                const out = fs.createWriteStream(tmp);
                const child = spawn('git', ['-C', dir, 'archive', '--format=zip', entry.commit], {
                    stdio: ['ignore', 'pipe', 'ignore'],
                });
                child.stdout.pipe(out);
                child.on('error', reject);
                out.on('error', reject);
                out.on('finish', resolve);
            });
            await fs.promises.rename(tmp, target);
            return target;
        })();
        archiveJobs.set(entry.commit, job);
        job.catch(() => {}).finally(() => archiveJobs.delete(entry.commit));
    }
    return archiveJobs.get(entry.commit);
}

async function handleVersionArchive(req, res, owner, repo, refText) {
    const dir = await ensureRepo(owner, repo);
    await fetchRepo(owner, repo);
    if (!(await isNapRepo(dir))) {
        sendError(res, 404, 'NAP のリポジトリではありません');
        return;
    }
    const { entries } = await readIndex(dir);
    const entry = resolveEntry(entries, refText);
    if (!entry) {
        sendError(res, 404, '版が見つかりません');
        return;
    }
    const file = await ensureArchiveFile(dir, entry);
    const stat = await fs.promises.stat(file);
    res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': stat.size,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=31536000, immutable',
    });
    if (req.method === 'HEAD') {
        res.end();
        return;
    }
    fs.createReadStream(file).pipe(res);
}

async function handleSearch(req, res, url, style) {
    // nap search と同じ動作。GitHub のコード検索で nap.json を持つ
    // リポジトリを探し、各リポジトリの nap.json を読んで返す。
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
    if (!token) {
        sendError(
            res,
            500,
            'GitHub のコード検索には認証が必要です。GITHUB_TOKEN にトークンを設定してください。',
        );
        return;
    }
    const q = (url.searchParams.get('q') || '').trim();
    const limit = Math.min(Number(url.searchParams.get('limit') || 20) || 20, 100);
    const apiBase = (process.env.NAP_GITHUB_API_BASE || 'https://api.github.com').replace(/\/+$/, '');
    const rawBase = (process.env.NAP_RAW_BASE || 'https://raw.githubusercontent.com').replace(/\/+$/, '');
    const query = ['filename:nap.json', ...q.split(/\s+/).filter(Boolean)].join(' ');
    let data;
    try {
        const apiRes = await fetch(
            `${apiBase}/search/code?q=${encodeURIComponent(query)}&per_page=100`,
            {
                headers: {
                    Accept: 'application/vnd.github+json',
                    Authorization: 'Bearer ' + token,
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            },
        );
        if (!apiRes.ok) {
            let detail = '';
            try {
                const body = await apiRes.json();
                detail = body && body.message ? `: ${body.message}` : '';
            } catch {
                detail = '';
            }
            sendError(res, 502, `GitHub API がエラーを返しました。HTTP ${apiRes.status}${detail}`);
            return;
        }
        data = await apiRes.json();
    } catch (error) {
        sendError(res, 502, `GitHub API へ接続できませんでした: ${error.message}`);
        return;
    }
    const seen = new Map();
    for (const item of data.items || []) {
        const fullName = item && item.repository && item.repository.full_name;
        if (!fullName || seen.has(fullName)) continue;
        seen.set(fullName, {
            repo: fullName,
            defaultBranch: item.repository.default_branch || 'HEAD',
        });
    }
    const candidates = [...seen.values()].slice(0, limit);
    const results = [];
    for (const candidate of candidates) {
        let name = candidate.repo.split('/')[1].toLowerCase();
        let description = '';
        let members = 0;
        try {
            const declRes = await fetch(
                `${rawBase}/${candidate.repo}/${candidate.defaultBranch}/nap.json`,
            );
            if (declRes.ok) {
                const declaration = await declRes.json();
                if (declaration && typeof declaration === 'object') {
                    if (declaration.name) name = declaration.name;
                    if (typeof declaration.description === 'string') {
                        description = declaration.description;
                    }
                    if (Array.isArray(declaration.composition)) {
                        members = declaration.composition.length;
                    }
                }
            }
        } catch {
            // nap.json を読めない候補は既定値のまま返す。
        }
        results.push({ repo: candidate.repo, name, description, members });
    }
    const total = data.total_count || results.length;
    if (style === 'api') {
        sendJson(
            res,
            200,
            {
                packages: results.map((result) => ({
                    repo: result.repo,
                    name: result.name,
                    description: result.description,
                    member_count: result.members,
                })),
                total,
                has_next: total > results.length,
            },
            'public, max-age=60',
        );
        return;
    }
    sendJson(res, 200, { query: q, total, results }, 'public, max-age=60');
}

async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const segments = url.pathname
        .split('/')
        .filter((seg) => seg.length > 0)
        .map((seg) => decodeURIComponent(seg));
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        });
        res.end();
        return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 405, 'GET だけに対応しています');
        return;
    }
    if (segments.length === 0) {
        sendJson(res, 200, OPENAPI, 'public, max-age=300');
        return;
    }
    if (segments.length === 1 && segments[0] === 'healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('ok\n');
        return;
    }
    try {
        if (segments[0] === 'api') {
            let style = 'api';
            let rest = segments.slice(1);
            if (rest[0] === 'v1') {
                style = 'legacy';
                rest = rest.slice(1);
            }
            if (style === 'api' && rest.length === 1 && rest[0] === 'spec') {
                sendJson(res, 200, OPENAPI, 'public, max-age=300');
                return;
            }
            if (rest.length === 1 && rest[0] === 'search') {
                await handleSearch(req, res, url, style);
                return;
            }
            if (rest[0] === 'repos' && rest.length >= 3) {
                const owner = rest[1];
                const repo = rest[2];
                if (!SEGMENT_PATTERN.test(owner) || !SEGMENT_PATTERN.test(repo)) {
                    sendError(res, 400, 'リポジトリの指定が不正です');
                    return;
                }
                if (rest.length === 3) {
                    await handleRepoInfo(req, res, owner, repo, style);
                    return;
                }
                if (rest.length === 4 && rest[3] === 'versions') {
                    await handleVersions(req, res, owner, repo, style, url);
                    return;
                }
                if (rest[3] === 'versions' && rest.length === 6 && rest[5] === 'archive.zip') {
                    await handleVersionArchive(req, res, owner, repo, rest[4]);
                    return;
                }
                if (rest[3] === 'versions' && rest.length === 5) {
                    await handleVersionDetail(req, res, owner, repo, rest[4], style);
                    return;
                }
            }
            sendError(res, 404, 'API が見つかりません');
            return;
        }
        if (segments.length >= 4) {
            const [owner, repo, ...rest] = segments;
            if (!SEGMENT_PATTERN.test(owner) || !SEGMENT_PATTERN.test(repo)) {
                sendError(res, 400, 'リポジトリの指定が不正です');
                return;
            }
            await handleRaw(req, res, owner, repo, rest);
            return;
        }
        sendError(res, 404, '見つかりません');
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            sendError(res, 404, '見つかりません');
            return;
        }
        const message = error && error.stderr ? String(error.stderr).trim() : '';
        if (/not found|does not exist|could not resolve|repository|does not appear|could not read/i.test(message)) {
            sendError(res, 404, 'リポジトリが見つかりません');
            return;
        }
        console.error('error:', error);
        sendError(res, 500, 'サーバーエラー');
    }
}

const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
        console.error('fatal:', error);
        if (!res.headersSent) sendError(res, 500, 'サーバーエラー');
    });
});
server.listen(PORT, () => {
    console.log(`nap-cdn listening on ${PORT} (data: ${DATA_DIR}, upstream: ${UPSTREAM})`);
});
