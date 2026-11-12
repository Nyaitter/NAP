'use strict';

const path = require('path');
const { git, gitText } = require('./git');
const {
    MANIFEST_NAME,
    INDEX_BRANCH,
    versionIdOf,
    parseManifest,
    parseVersionRef,
    tagRefFor,
    isVersionCode,
} = require('./core');
const { readIndexAt, openSnapshot, listTagIds } = require('./read');
const { resolveRepoRoot } = require('./publish');

async function list(repoSpec, options = {}) {
    const root = resolveRepoRoot(repoSpec);
    const snapshot = openSnapshot(root, options.remote || 'origin');
    const { head, entries } = readIndexAt(snapshot, `refs/heads/${INDEX_BRANCH}`);
    if (entries.length === 0) {
        console.log('版はまだありません。');
        return;
    }
    console.log(`版の総数: ${head.total} / 表示: ${entries.length} 件`);
    let latestFormal = -1;
    entries.forEach((entry, index) => {
        if (!entry.tag) latestFormal = index;
    });
    entries.forEach((entry, index) => {
        const marks = [];
        if (entry.tag) marks.push(`開発中: ${entry.tag}`);
        if (index === latestFormal) marks.push('最新');
        const display = entry.tag ? `${entry.id}-${entry.tag}` : entry.id;
        const code = entry.code ? ` code=${entry.code}` : '';
        console.log(
            `  ${entry.id.slice(0, 12)} ${display}${code} commit=${entry.commit.slice(0, 12)} at=${entry.at}${marks.length ? ` / ${marks.join('、')}` : ''}`,
        );
    });
}

// 「<版ID>」または「<版ID>-<ラベル>」の指定を、タグの一覧から一意に解決する。
// ラベルなしの指定は正式版だけを対象にする。
function resolveVersionRef(snapshot, refText) {
    const { prefix, tag } = parseVersionRef(refText);
    const matches = listTagIds(snapshot)
        .map((suffix) => {
            try {
                const parsed = parseVersionRef(suffix);
                return { id: parsed.prefix, tag: parsed.tag };
            } catch {
                return null;
            }
        })
        .filter((candidate) => candidate && candidate.id.startsWith(prefix) && candidate.tag === tag);
    if (matches.length === 0) throw new Error(`版が見つかりません: ${refText}`);
    if (matches.length > 1) throw new Error(`版が一意に決まりません: ${refText}`);
    return matches[0];
}

async function show(versionRefText, options = {}) {
    const root = resolveRepoRoot(options.repo);
    const snapshot = openSnapshot(root, options.remote || 'origin');
    let resolved;
    if (versionRefText) {
        // 版コードは索引から引く。版IDの省略形より優先する。
        let byCode = null;
        if (isVersionCode(versionRefText)) {
            const { entries: codeEntries } = readIndexAt(snapshot, `refs/heads/${INDEX_BRANCH}`);
            const hit = codeEntries.find((entry) => entry.code === versionRefText);
            if (hit) byCode = { id: hit.id, tag: hit.tag || null };
        }
        resolved = byCode || resolveVersionRef(snapshot, versionRefText);
    } else {
        // 版の指定が無ければ、最新の正式版を指す。TestVersion は勝手に選ばない。
        const { entries } = readIndexAt(snapshot, `refs/heads/${INDEX_BRANCH}`);
        if (entries.length === 0) throw new Error('版はまだありません。');
        const formal = entries.filter((entry) => !entry.tag);
        if (formal.length === 0) {
            throw new Error('正式版はまだありません。開発中の版だけが発行されています。');
        }
        resolved = { id: formal[formal.length - 1].id, tag: null };
    }
    const { id, tag } = resolved;
    const commit = gitText(
        ['--git-dir', snapshot, 'rev-parse', `refs/tags/${tagRefFor(id, tag)}`],
        {},
    );
    let manifest;
    try {
        manifest = parseManifest(
            git(['--git-dir', snapshot, 'cat-file', 'blob', `${commit}:${MANIFEST_NAME}`], {}),
        );
    } catch (error) {
        throw new Error(`マニフェストを読めません: ${error.message}`);
    }
    const recomputed = versionIdOf(manifest.files, manifest.libraries);
    console.log(`版ID: ${id}`);
    if (tag) console.log(`ラベル: ${tag}。開発中の版`);
    console.log(`再計算: ${recomputed === id ? '一致' : `不一致: ${recomputed}`}`);
    const { entries: showEntries } = readIndexAt(snapshot, `refs/heads/${INDEX_BRANCH}`);
    const shown = showEntries.find((e) => e.id === id && (e.tag || null) === (tag || null));
    if (shown && shown.source) console.log(`出典コミット: ${shown.source}`);
    if (shown && shown.code) console.log(`版コード: ${shown.code}`);
    const description = gitText(['--git-dir', snapshot, 'log', '-1', '--format=%b', commit], {});
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

module.exports = { list, show };
