'use strict';

const { git, refExists } = require('./git');

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

module.exports = { readIndexAt };
