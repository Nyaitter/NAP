'use strict';

// nap list と nap show。読み取りは HTTP で行い、git は使わない。
// 索引と版のタグは配信の URL から、説明は GitHub の API から読む。
// 説明が読めないときは、その項目を空にして止めない。

const {
    versionIdOf,
    parseVersionRef,
    isVersionCode,
} = require('./core');
const { parseGetTarget } = require('./get');

const GITHUB_API = 'https://api.github.com';

function apiBase() {
    return (process.env.NAP_GITHUB_API_BASE || GITHUB_API).replace(/\/$/, '');
}

async function fetchJson(url) {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'nap' };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function list(repoSpec, options = {}) {
    const repo = repoSpec || await currentRepo();
    const { createClient } = await import('../client/nap-client.js');
    const client = createClient({ rawBase: process.env.NAP_RAW_BASE || undefined });
    const { total, entries } = await client.listVersions(repo);
    if (entries.length === 0) {
        console.log('版はまだありません。');
        return;
    }
    console.log(`版の総数: ${total} / 表示: ${entries.length} 件`);
    let latestFormal = -1;
    entries.forEach((entry, index) => {
        if (!entry.tag) latestFormal = index;
    });
    for (const [index, entry] of entries.entries()) {
        const marks = [];
        if (entry.tag) marks.push(`開発中: ${entry.tag}`);
        if (index === latestFormal) marks.push('最新');
        const display = entry.tag ? `${entry.id}-${entry.tag}` : entry.id;
        const code = entry.code ? ` code=${entry.code}` : '';
        console.log(
            `  ${entry.id.slice(0, 12)} ${display}${code} at=${entry.at}${marks.length ? ` / ${marks.join('、')}` : ''}`,
        );
    }
}

// git があるときは、今のリポジトリの origin を既定の対象にする。
// git が無いときは、対象を引数で指定させる。
async function currentRepo() {
    let url;
    try {
        const { gitText } = require('./git');
        url = gitText(['remote', 'get-url', 'origin'], {});
    } catch {
        throw new Error(
            '対象の指定がありません。<所有者>/<リポジトリ> の形で指定してください。',
        );
    }
    const repo = repoFromRemoteUrl(url);
    if (!repo) {
        throw new Error(
            '対象の指定がありません。<所有者>/<リポジトリ> の形で指定してください。',
        );
    }
    return repo;
}

// 短縮した版IDを一意に解決する。
function resolveByPrefix(entries, refText) {
    const { prefix, tag } = parseVersionRef(refText);
    const matches = [];
    for (const entry of entries) {
        if (!entry.id.startsWith(prefix)) continue;
        if ((entry.tag || null) !== (tag || null)) continue;
        matches.push(entry);
    }
    if (matches.length === 0) throw new Error(`版が見つかりません: ${refText}`);
    if (matches.length > 1) throw new Error(`版が一意に決まりません: ${refText}`);
    return matches[0];
}

// リモートの URL から「<所有者>/<リポジトリ>」を取り出す。
// https 形式と git@ の SSH 形式の両方に対応する。
function repoFromRemoteUrl(url) {
    let text = String(url || '').trim().replace(/\.git$/, '');
    text = text.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
    text = text.replace(/^[^/@]+@/, '');
    text = text.replace(':', '/');
    const parts = text.split('/').filter(Boolean);
    if (parts.length < 3) return null;
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}
async function show(versionRefText, options = {}) {
    let refText = versionRefText || null;
    let repo = options.repo || null;
    // 指定が「<所有者>/<リポジトリ>」の形なら対象の指定として読む。
    // 版まで含む形なら、対象と版の両方を読む。
    if (refText && refText.includes('/')) {
        const parsed = parseGetTarget(refText);
        if (repo && repo.toLowerCase() !== parsed.repo.toLowerCase()) {
            throw new Error(`対象の指定が重なっています: ${refText} と --repo ${repo}`);
        }
        repo = parsed.repo;
        refText = parsed.ref;
    }
    repo = repo || await currentRepo();
    const { createClient } = await import('../client/nap-client.js');
    const client = createClient({ rawBase: process.env.NAP_RAW_BASE || undefined });
    const { entries } = await client.listVersions(repo);
    if (entries.length === 0) throw new Error('版はまだありません。');
    let resolved = null;
    let codeBy = null;
    if (refText) {
        if (isVersionCode(refText)) {
            codeBy = entries.find((entry) => entry.code === refText) || null;
        }
        if (codeBy) {
            resolved = codeBy;
        } else {
            try {
                resolved = resolveByPrefix(entries, refText);
            } catch (error) {
                // 版コードの形をしていて版IDの先頭としても読めない指定は、
                // 形の誤りではなく、このリポジトリに無い版として伝える。
                if (isVersionCode(refText) && error.message.startsWith('版の指定が不正です')) {
                    throw new Error(`版が見つかりません: ${refText}`);
                }
                throw error;
            }
        }
    } else {
        const formal = entries.filter((entry) => !entry.tag);
        if (formal.length === 0) {
            throw new Error('正式版はまだありません。開発中の版だけが発行されています。');
        }
        resolved = formal[formal.length - 1];
    }
    const { id, tag } = resolved;
    const fullRef = tag ? `${id}-${tag}` : id;
    const manifest = await client.getManifest(repo, fullRef);
    const recomputed = versionIdOf(manifest.files, manifest.libraries);
    console.log(`版ID: ${id}`);
    if (tag) console.log(`ラベル: ${tag}。開発中の版`);
    console.log(`再計算: ${recomputed === id ? '一致' : `不一致: ${recomputed}`}`);
    if (resolved.source) console.log(`出典コミット: ${resolved.source}`);
    if (resolved.code) console.log(`版コード: ${resolved.code}`);
    const description = await describeVersion(repo, resolved);
    if (description) console.log(`説明: ${description}`);
    console.log(`ファイル: ${Object.keys(manifest.files).length} 点`);
    for (const rel of Object.keys(manifest.files)) {
        console.log(`  ${rel} ${manifest.files[rel].slice(0, 12)}`);
    }
    const refs = Object.keys(manifest.libraries);
    console.log(`構成員: ${refs.length} 件`);
    for (const ref of refs) {
        const lib = manifest.libraries[ref];
        console.log(`  ${ref} repo=${lib.repo} version=${lib.version}`);
    }
    return { id, tag, manifest };
}

// 説明を GitHub の API から読む。版のコミットには、1行目に版IDが、
// 続きに説明が入っている。読めなければ空にする。
async function describeVersion(repo, entry) {
    if (!entry.commit) return '';
    try {
        const data = await fetchJson(`${apiBase()}/repos/${repo}/git/commits/${entry.commit}`);
        const message = typeof data.message === 'string' ? data.message : '';
        const lines = message.split('\n').map((line) => line.trim());
        while (lines.length > 0 && lines[0] === '') lines.shift();
        return lines.slice(1).join('\n').trim();
    } catch {
        return '';
    }
}

module.exports = { list, show };
