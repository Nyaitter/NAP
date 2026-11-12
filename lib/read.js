'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { git, gitText, refExists, remoteUrl } = require('./git');
const { INDEX_BRANCH, VERSIONS_BRANCH } = require('./core');

// 指定した ref の索引をリポジトリ内から読む。索引は先頭ファイルと全チャンク。無ければ空。
function readIndexAt(root, ref) {
    if (!refExists(root, ref)) {
        return { head: { chunks: [], total: 0 }, entries: [] };
    }
    const head = JSON.parse(git(['show', `${ref}:index.json`], { cwd: root }).toString('utf8'));
    const entries = [];
    for (const chunk of head.chunks) {
        const list = JSON.parse(
            git(['show', `${ref}:${chunk.file}`], { cwd: root }).toString('utf8'),
        );
        for (const entry of list) entries.push({ ...entry, chunkFile: chunk.file });
    }
    return { head, entries };
}

// リモートから索引・タグ・nap/versions ブランチを取り込んだ一時 bare リポジトリを作る。
// 読み取り専用の作業場所で、対象リポジトリの ref は汚さない。
function openSnapshot(root, remote) {
    const url = remoteUrl(root, remote);
    const key = crypto
        .createHash('sha256')
        .update(`${root}\n${url}`)
        .digest('hex')
        .slice(0, 16);
    const dir = path.join(os.tmpdir(), `nap-read-${key}`);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        git(['init', '--bare', '--quiet', dir], {});
    }
    const refspecs = [
        `+refs/heads/${INDEX_BRANCH}:refs/heads/${INDEX_BRANCH}`,
        `+refs/heads/${VERSIONS_BRANCH}:refs/heads/${VERSIONS_BRANCH}`,
        '+refs/tags/nap/*:refs/tags/nap/*',
    ];
    for (const refspec of refspecs) {
        try {
            git(['--git-dir', dir, 'fetch', '--quiet', url, refspec], {});
        } catch {
            // リモートにまだ無い ref は取り込まない
        }
    }
    return dir;
}

function listTagIds(snapshotDir) {
    let out = '';
    try {
        out = gitText(['--git-dir', snapshotDir, 'tag', '-l', 'nap/*'], {});
    } catch {
        return [];
    }
    return out
        .split('\n')
        .filter(Boolean)
        .map((tag) => tag.slice('nap/'.length));
}

module.exports = { readIndexAt, openSnapshot, listTagIds };
