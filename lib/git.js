'use strict';

const { execFileSync } = require('child_process');

const MAX_BUFFER = 512 * 1024 * 1024;

// git を実行して標準出力を Buffer で返す。失敗したら例外。
function git(args, { cwd, env, input } = {}) {
    return execFileSync('git', args, {
        cwd,
        env: { ...process.env, ...(env || {}) },
        input,
        maxBuffer: MAX_BUFFER,
    });
}

function gitText(args, opts) {
    return git(args, opts).toString('utf8').trim();
}

function refExists(root, ref) {
    try {
        gitText(['rev-parse', '--verify', '--quiet', ref], { cwd: root });
        return true;
    } catch {
        return false;
    }
}

// リモート名から URL を引く。引けない場合は指定そのものを URL／パスとして扱う。
function remoteUrl(root, remote) {
    try {
        return gitText(['remote', 'get-url', remote], { cwd: root });
    } catch {
        return remote;
    }
}

module.exports = { git, gitText, refExists, remoteUrl };
