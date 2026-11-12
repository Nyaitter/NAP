'use strict';

// nap fork: パッケージのフォークを nap_modules へ置く。フォークはリポジトリの複製。
// パッケージ自体が Git リポジトリであることを利用し、clone した作業ツリーを
// そのまま導入済みの場所に置く。導入済みなら置き換え、未導入なら導入になる。
// 以後、その場所は通常の Git リポジトリとして編集でき、nap get では上書きされず、
// nap publish では現在の内容が版へ埋め込まれる。

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sha256Hex } = require('./core');
const { parseGetTarget, dependencyRefFor, recordDependency, MODULES_DIR } = require('./get');
const { readIndexAt } = require('./read');
const { INDEX_BRANCH } = require('./core');

function git(args, options = {}) {
    return execFileSync('git', args, { encoding: 'utf8', ...options });
}

// ソースから clone 先の URL を作る。ソースは「<所有者>/<リポジトリ>」の形。
function cloneUrlFor(repo) {
    return `https://github.com/${repo}.git`;
}

function isForkDir(dir) {
    return fs.existsSync(path.join(dir, '.git'));
}

// 導入済みコピーが導入時の内容から変わっているか。フォークではないものが対象。
function installedDiverged(dir) {
    const manifestPath = path.join(dir, 'version-manifest.json');
    if (!fs.existsSync(manifestPath)) return true;
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
        return true;
    }
    for (const [rel, hash] of Object.entries(manifest.files || {})) {
        const filePath = path.join(dir, rel);
        if (!fs.existsSync(filePath)) return true;
        if (sha256Hex(fs.readFileSync(filePath)) !== hash) return true;
    }
    return false;
}

async function fork(specText) {
    const cwd = process.cwd();
    const declarationPath = path.join(cwd, 'nap.json');
    if (!fs.existsSync(declarationPath)) {
        throw new Error(
            'nap.json がありません。フォークは、プロジェクトのフォルダで実行してください。',
        );
    }
    const { repo, ref } = parseGetTarget(specText);
    const depRef = dependencyRefFor(repo);
    const targetDir = path.join(cwd, MODULES_DIR, depRef);
    if (isForkDir(targetDir)) {
        throw new Error(`既にフォークされています: ${depRef}。場所: ${targetDir}`);
    }
    if (fs.existsSync(targetDir) && installedDiverged(targetDir)) {
        throw new Error(
            '導入済みのコピーが変更されています。フォークで置き換えると変更が失われるため止めました。',
        );
    }

    // 版を確定する。取得ライブラリで実在を確かめる。
    const { createClient } = await import('../client/nap-client.js');
    const client = createClient({ rawBase: process.env.NAP_RAW_BASE || undefined });
    let versionId;
    let label = null;
    if (ref === null) {
        const latest = await client.latestVersion(repo);
        if (!latest) throw new Error(`正式版はまだありません: ${repo}`);
        versionId = latest.id;
    } else {
        const resolved = await client.fetchVersion(repo, ref);
        versionId = resolved.versionId;
        label = resolved.tag || null;
    }

    const tmpDir = `${targetDir}.fork-tmp`;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    try {
        git(['clone', '--quiet', cloneUrlFor(repo), tmpDir], { stdio: 'inherit' });
        if (ref !== null) {
            // 基点は、版の出典コミットか、版のツリーにする。出典コミットは辿れる場合。
            const tagRef = label ? `nap/${versionId}-${label}` : `nap/${versionId}`;
            // 出典は索引に記録されている。出典は発行の対象だったコミット。
            // clone した側の索引から引き、コミットが手元にあればそれを基点にする。
            const { entries } = readIndexAt(tmpDir, `refs/remotes/origin/${INDEX_BRANCH}`);
            const hit = entries.find(
                (e) => e.id === versionId && (e.tag || null) === (label || null),
            );
            let source = null;
            if (hit && hit.source) {
                try {
                    git(['rev-parse', '--verify', '--quiet', `${hit.source}^{commit}`], {
                        cwd: tmpDir,
                    });
                    source = hit.source;
                } catch {
                    source = null;
                }
            }
            git(['checkout', '--quiet', source || `refs/tags/${tagRef}`], { cwd: tmpDir });
            if (!fs.existsSync(path.join(tmpDir, 'nap.json'))) {
                // 宣言が版のツリーに無い場合は、既定ブランチのものを持ってくる。
                let declaration;
                try {
                    declaration = git(['show', 'origin/HEAD:nap.json'], { cwd: tmpDir });
                } catch {
                    throw new Error(
                        'パッケージの宣言 nap.json が、版のツリーにも既定ブランチにもありません。',
                    );
                }
                fs.writeFileSync(path.join(tmpDir, 'nap.json'), declaration);
                git(['add', 'nap.json'], { cwd: tmpDir });
                git(['commit', '--quiet', '-m', 'fork: add nap.json from default branch'], {
                    cwd: tmpDir,
                    env: {
                        ...process.env,
                        GIT_AUTHOR_NAME: 'nap',
                        GIT_AUTHOR_EMAIL: 'nap@localhost',
                        GIT_COMMITTER_NAME: 'nap',
                        GIT_COMMITTER_EMAIL: 'nap@localhost',
                    },
                });
            }
        }
        fs.mkdirSync(path.dirname(targetDir), { recursive: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.renameSync(tmpDir, targetDir);
    } catch (error) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        throw error;
    }

    const text = fs.readFileSync(declarationPath, 'utf8');
    fs.writeFileSync(declarationPath, recordDependency(text, depRef, versionId));
    console.log(`フォーク: ${depRef} = ${versionId}`);
    console.log(`場所: ${targetDir}`);
    console.log('origin は元のリポジトリです。自分の場所へ出すときは差し替えてください。');
}

module.exports = { fork, cloneUrlFor, isForkDir };
