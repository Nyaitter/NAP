'use strict';

const fs = require('fs');
const path = require('path');
const { parseDeclaration } = require('./declaration');

const ID_PATTERN = /^[0-9a-f]{64}$/;
const MODULES_DIR = 'nap_modules';

// 取り寄せの指定を分解する。版まで含む指定と、
// ソースだけの指定の両方を受ける。
// ソースだけの場合は ref が null になり、最新の正式版に解決する。
function parseGetTarget(text) {
    if (typeof text !== 'string' || !text.trim()) {
        throw new Error(`指定が不正です: ${text}`);
    }
    const spec = text.trim();
    const parts = spec.split('/');
    if (parts.length === 3 && parts.every((part) => part.length > 0)) {
        return { repo: `${parts[0]}/${parts[1]}`, ref: parts[2] };
    }
    if (parts.length === 2 && parts.every((part) => part.length > 0)) {
        return { repo: spec, ref: null };
    }
    throw new Error(
        `指定が不正です: ${spec}。「<所有者>/<リポジトリ>」または「<所有者>/<リポジトリ>/<版>」で指定してください`,
    );
}

// ソースから、nap.json の依存関係に書く参照を導く。参照は「<組織ID>/<名前>」の形。
function dependencyRefFor(repo) {
    const parts = String(repo).split('/').filter((part) => part.length > 0);
    if (parts.length !== 2) {
        throw new Error(`依存関係の参照を導けません: ${repo}`);
    }
    return `${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
}

function defaultOutDir(repo) {
    const base = repo.split('/').pop();
    return path.resolve(process.cwd(), base || 'nap-package');
}

function assertSafeRel(rel) {
    const segments = rel.split('/');
    if (path.isAbsolute(rel) || segments.includes('..') || segments.includes('')) {
        throw new Error(`不正なファイルパスです: ${rel}`);
    }
}

function writePackageFiles(dir, pkg) {
    if (pkg.manifest) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'version-manifest.json'),
            `${JSON.stringify(pkg.manifest, null, 2)}\n`,
        );
    }
    for (const [rel, bytes] of Object.entries(pkg.files || {})) {
        assertSafeRel(rel);
        const target = path.join(dir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes);
    }
}

function writeExtract(dir, pkg, label) {
    writePackageFiles(dir, pkg);
    console.log(`${label}: ${Object.keys(pkg.files || {}).length} 点 → ${dir}`);
    for (const [ref, lib] of Object.entries(pkg.libraries || {})) {
        writeExtract(path.join(dir, 'libraries', ref), lib, `構成員 ${ref}`);
    }
}

// 導入先にパッケージを置く。そのパッケージの構成員は、同じ nap_modules の
// 直下へ並べて置く。依存関係への記録は、直接導入したものだけが行う。
function isForkDir(dir) {
    return fs.existsSync(path.join(dir, '.git'));
}

// writeInstalled はフォーク済みの場所を上書きしない。
function writeInstalled(modulesDir, ref, pkg) {
    if (isForkDir(path.join(modulesDir, ref))) {
        console.log(`フォーク済みのため、そのままにしました: ${ref}`);
        return;
    }
    const dir = path.join(modulesDir, ref);
    fs.rmSync(dir, { recursive: true, force: true });
    writePackageFiles(dir, pkg);
    for (const [libRef, lib] of Object.entries(pkg.libraries || {})) {
        writeInstalled(modulesDir, libRef, lib);
    }
}

// nap.json の依存関係 composition に、参照と版を記録した新しい宣言文を作る。
// 記録の形は検証を通してから返す。呼び出し側は、設置が終わるまで書き込まない。
function recordDependency(declarationText, ref, versionId) {
    const doc = JSON.parse(declarationText);
    const composition = Array.isArray(doc.composition) ? [...doc.composition] : [];
    const entryName = (entry) => (typeof entry === 'string' ? entry : entry && entry.name);
    const index = composition.findIndex((entry) => entryName(entry) === ref);
    const record = { name: ref, version: versionId };
    if (index >= 0) composition[index] = record;
    else composition.push(record);
    doc.composition = composition;
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    parseDeclaration(text);
    return text;
}

// 実行ディレクトリの nap.json に記録された依存関係を、すべて導入する。
// 取得先のソースは、参照から導いたものを使う。参照は「<組織ID>/<名前>」の形。
async function installAll() {
    const cwd = process.cwd();
    const declarationPath = path.join(cwd, 'nap.json');
    if (!fs.existsSync(declarationPath)) {
        throw new Error(
            'nap.json がありません。依存の一括導入は、プロジェクトのフォルダで実行してください。',
        );
    }
    const declarationText = fs.readFileSync(declarationPath, 'utf8');
    const declaration = parseDeclaration(declarationText);
    if (!declaration.composition || declaration.composition.length === 0) {
        console.log('依存関係は記録されていません。');
        return;
    }
    const { createClient } = await import('../client/nap-client.js');
    const client = createClient({ rawBase: process.env.NAP_RAW_BASE || undefined });
    let text = declarationText;
    for (const member of declaration.composition) {
        if (isForkDir(path.join(cwd, MODULES_DIR, member.ref))) {
            console.log(`フォーク済みのため、そのままにしました: ${member.ref}`);
            continue;
        }
        let ref = member.version;
        if (!ref) {
            const latest = await client.latestVersion(member.ref);
            if (!latest) {
                throw new Error(`正式版はまだありません: ${member.ref}`);
            }
            ref = latest.id;
        }
        const result = await client.fetchVersion(member.ref, ref);
        writeInstalled(path.join(cwd, MODULES_DIR), member.ref, result);
        text = recordDependency(text, member.ref, result.versionId);
        console.log(`導入: ${member.ref} = ${result.versionId}`);
    }
    fs.writeFileSync(declarationPath, text);
    console.log('依存関係をすべて導入しました。');
}

async function get(specText, options = {}) {
    if (specText === undefined || specText === null) {
        if (options.out) {
            throw new Error('一括導入では --out は使えません。');
        }
        return installAll();
    }
    const { repo, ref } = parseGetTarget(specText);
    const { createClient } = await import('../client/nap-client.js');
    const client = createClient({ rawBase: process.env.NAP_RAW_BASE || undefined });

    let targetRef = ref;
    if (!targetRef) {
        const latest = await client.latestVersion(repo);
        if (!latest) {
            throw new Error(`正式版はまだありません: ${repo}`);
        }
        targetRef = latest.id;
    }
    const result = await client.fetchVersion(repo, targetRef);

    // 実行ディレクトリに nap.json があり、出力先の明示が無い場合は「導入」になる。
    const cwd = process.cwd();
    const declarationPath = path.join(cwd, 'nap.json');
    if (!options.out && fs.existsSync(declarationPath)) {
        const depRef = dependencyRefFor(repo);
        const modulesDir = path.join(cwd, MODULES_DIR);
        if (isForkDir(path.join(modulesDir, depRef))) {
            console.log(
                `版ID: ${result.versionId}${result.tag ? ` / 開発中の版: ${result.tag}` : ''}`,
            );
            console.log(`フォーク済みのため、そのままにしました: ${depRef}`);
            return;
        }
        const declarationText = fs.readFileSync(declarationPath, 'utf8');
        parseDeclaration(declarationText);
        const updated = recordDependency(declarationText, depRef, result.versionId);
        writeInstalled(modulesDir, depRef, result);
        fs.writeFileSync(declarationPath, updated);
        console.log(`版ID: ${result.versionId}${result.tag ? ` / 開発中の版: ${result.tag}` : ''}`);
        console.log(`導入: ${depRef} → ${path.join(modulesDir, depRef)}`);
        console.log(`依存関係に記録しました: ${depRef} = ${result.versionId}`);
        return;
    }

    const outDir = options.out ? path.resolve(options.out) : defaultOutDir(repo);
    if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
        throw new Error(`出力先が空ではありません: ${outDir}`);
    }
    fs.mkdirSync(outDir, { recursive: true });
    console.log(`版ID: ${result.versionId}${result.tag ? ` / 開発中の版: ${result.tag}` : ''}`);
    writeExtract(outDir, result, '本体');
    console.log(
        `取得: ${result.stats.fetched} 件 / キャッシュ: ${result.stats.cached} 件`,
    );
}

module.exports = { get, installAll, parseGetTarget, dependencyRefFor, recordDependency, isForkDir, MODULES_DIR };
