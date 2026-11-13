'use strict';

const { execFileSync } = require('child_process');

const MAX_BUFFER = 512 * 1024 * 1024;

// git を実行して標準出力を Buffer で返す。失敗したら例外。
// git 自身の英文は利用者に出さないため、ここで置き換える。
function git(args, { cwd, env, input, ...rest } = {}) {
    let result;
    try {
        result = execFileSync('git', args, {
            cwd,
            env: { ...process.env, ...(env || {}) },
            input,
            maxBuffer: MAX_BUFFER,
            stdio: ['pipe', 'pipe', 'pipe'],
            ...rest,
        });
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            throw new Error('git が必要です。インストールしてから実行してください。');
        }
        const message = new Error(`git の実行に失敗しました: git ${args.join(' ')}`);
        message.detail = error.stderr ? error.stderr.toString('utf8').trim() : '';
        throw message;
    }
    if (Buffer.isBuffer(result)) return result;
    return Buffer.from(result || '', 'utf8');
}

let gitPresent;
// git が必要な操作の最初に呼ぶ。git が無ければ説明で止める。
function ensureGit() {
    if (gitPresent === undefined) {
        try {
            git(['--version'], {});
            gitPresent = true;
        } catch {
            gitPresent = false;
        }
    }
    if (!gitPresent) {
        throw new Error('git が必要です。インストールしてから実行してください。');
    }
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

module.exports = { git, gitText, refExists, remoteUrl, ensureGit };
