'use strict';

const crypto = require('crypto');

const MANIFEST_NAME = 'version-manifest.json';
const VERSIONS_BRANCH = 'nap/versions';
const INDEX_BRANCH = 'nap/index';
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
        throw new Error(
            `ラベルが不正です: ${label}。1〜32文字、英数字で始まり、使える文字は英数字と . _ - 。末尾の . と連続した .. は使えません`,
        );
    }
    return label;
}

// 「<版ID>」または「<版ID>-<ラベル>」を分解する。版IDは前方一致の短縮でもよい。
// 16進数には - が含まれないため、最初の - で一意に分かれる。
function parseVersionRef(ref) {
    if (typeof ref !== 'string' || ref.length === 0) {
        throw new Error(`版の指定が不正です: ${ref}`);
    }
    const dash = ref.indexOf('-');
    const prefix = dash === -1 ? ref : ref.slice(0, dash);
    const tag = dash === -1 ? null : ref.slice(dash + 1);
    if (!/^[0-9a-f]{1,64}$/.test(prefix)) {
        throw new Error(`版の指定が不正です: ${ref}`);
    }
    if (tag !== null) validateLabel(tag);
    return { prefix, tag };
}

// 版を指すタグ名。正式版は nap/<版ID>、TestVersion は nap/<版ID>-<ラベル>。
function tagRefFor(id, tag) {
    return tag ? `nap/${id}-${tag}` : `nap/${id}`;
}

function sha256Hex(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function compareBytes(a, b) {
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function hashLines(lines) {
    const sorted = [...lines].sort(compareBytes);
    return sha256Hex(Buffer.from(`${sorted.join('\n')}\n`, 'utf8'));
}

// パッケージIDは、自ファイルの `F <パス> <sha256>` 行だけから生成する。
function packageIdOf(files) {
    return hashLines(Object.entries(files).map(([rel, hash]) => `F ${rel} ${hash}`));
}

// 版IDは、自ファイルの F 行と、構成員の `P <組織ID>/<名前> <版ID>` 行から生成する。
// libraries は { "<組織ID>/<名前>": "<版ID>" または { version } } の形で受ける。
function versionIdOf(files, libraries) {
    const lines = Object.entries(files).map(([rel, hash]) => `F ${rel} ${hash}`);
    for (const [ref, lib] of Object.entries(libraries)) {
        const version = typeof lib === 'string' ? lib : lib.version;
        lines.push(`P ${ref} ${version}`);
    }
    return hashLines(lines);
}

// マニフェストの中身。版ID自身と日時は入れない。自己参照を避けるため。
// libraries の各項目は { name, repo, version } を持つ。キーは決定的な並びにする。
function manifestBuffer(files, libraries) {
    const sortedFiles = {};
    for (const rel of Object.keys(files).sort(compareBytes)) sortedFiles[rel] = files[rel];
    const sortedLibs = {};
    for (const ref of Object.keys(libraries).sort(compareBytes)) {
        const lib = libraries[ref];
        sortedLibs[ref] = { name: ref, repo: lib.repo, version: lib.version };
    }
    return Buffer.from(
        `${JSON.stringify({ files: sortedFiles, libraries: sortedLibs }, null, 2)}\n`,
        'utf8',
    );
}

const CODE_PATTERN = /^[0-9a-z]{3,}$/;
const CODE_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

// 版コードの形かどうか。版IDの完全な形とは重ならない。
function isVersionCode(text) {
    if (typeof text !== 'string' || !CODE_PATTERN.test(text)) return false;
    return !/^[0-9a-f]{64}(-[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(text);
}

// 未使用の版コードを生成する。最小3桁で、その桁が埋まっていれば次の桁にする。
function generateVersionCode(used) {
    let length = 3;
    while (
        [...used].filter((code) => code.length === length).length >=
        CODE_ALPHABET.length ** length
    ) {
        length++;
    }
    for (let attempt = 0; attempt < 100; attempt++) {
        let code = '';
        for (let i = 0; i < length; i++) {
            code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
        }
        if (!used.has(code)) return code;
    }
    // その桁がほぼ埋まっている場合は、次の桁で引く。
    for (let attempt = 0; attempt < 1000; attempt++) {
        let code = '';
        for (let i = 0; i < length + 1; i++) {
            code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
        }
        if (!used.has(code)) return code;
    }
    throw new Error('版コードを生成できませんでした。');
}

// ソースの指定は「<所有者>/<リポジトリ>」だけ。GitHub 前提。
function isSourceSpec(source) {
    if (typeof source !== 'string') return false;
    const text = source.trim();
    if (!text) return false;
    const parts = text.split('/');
    return parts.length === 2 && parts.every((part) => part.length > 0 && !/[\s:@]/.test(part));
}

function parseManifest(buffer) {
    let manifest;
    try {
        manifest = JSON.parse(buffer.toString('utf8'));
    } catch {
        throw new Error('マニフェストが JSON として読めません。');
    }
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

module.exports = {
    MANIFEST_NAME,
    VERSIONS_BRANCH,
    INDEX_BRANCH,
    ID_PATTERN,
    validateLabel,
    parseVersionRef,
    tagRefFor,
    sha256Hex,
    compareBytes,
    packageIdOf,
    versionIdOf,
    manifestBuffer,
    parseManifest,
    isSourceSpec,
    isVersionCode,
    generateVersionCode,
};
