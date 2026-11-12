'use strict';

const DECLARATION_FILE = 'nap.json';
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ID_PATTERN = /^[0-9a-f]{64}$/;

function parseComposition(raw, where) {
    if (raw === undefined) return null;
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error(`${where}.composition には構成員が1件以上必要です。`);
    }
    const seen = new Set();
    return raw.map((entry, index) => {
        const at = `${where}.composition[${index}]`;
        const ref = typeof entry === 'string' ? entry : entry && entry.name;
        const version = typeof entry === 'string' ? null : entry && entry.version;
        // 構成員の参照は「<組織ID>/<パッケージ名>」で、組織IDは省略できない。
        const slash = typeof ref === 'string' ? ref.indexOf('/') : -1;
        const org = slash > 0 ? ref.slice(0, slash) : '';
        const name = slash > 0 ? ref.slice(slash + 1) : '';
        if (!NAME_PATTERN.test(org) || !NAME_PATTERN.test(name)) {
            throw new Error(`${at} のパッケージ参照が不正です。<組織ID>/<パッケージ名> の形で書いてください。`);
        }
        if (seen.has(ref)) {
            throw new Error(`構成員が重複しています: ${ref}`);
        }
        seen.add(ref);
        if (version !== null && version !== undefined) {
            if (typeof version !== 'string' || !ID_PATTERN.test(version)) {
                throw new Error(`${at}.version は版IDで書いてください。版IDは16進数64桁です。`);
            }
            return { ref, org, name, version };
        }
        return { ref, org, name, version: null };
    });
}

// 宣言は1リポジトリ1パッケージのフラットな形式だけを受ける。
// 旧形式の packages 配列は互換読みせず、明確なエラーにする。
function parseDeclaration(text) {
    let doc;
    try {
        doc = JSON.parse(text);
    } catch {
        throw new Error(`${DECLARATION_FILE} が JSON として読めません。`);
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new Error(`${DECLARATION_FILE} の形式が不正です。`);
    }
    if ('packages' in doc) {
        throw new Error(
            `${DECLARATION_FILE} の旧形式 packages 配列は使えません。` +
                'name／include／composition をトップレベルに書いてください。',
        );
    }
    if (typeof doc.name !== 'string' || !NAME_PATTERN.test(doc.name)) {
        throw new Error(
            `${DECLARATION_FILE}.name が不正です。小文字の英数字と . _ - で始まる名前を使ってください。`,
        );
    }
    if (
        !Array.isArray(doc.include) ||
        doc.include.length === 0 ||
        doc.include.some((pattern) => typeof pattern !== 'string' || pattern.length === 0)
    ) {
        throw new Error(`${DECLARATION_FILE}.include には対象ファイルの指定が1件以上必要です。`);
    }
    for (const pattern of doc.include) {
        const body = pattern.startsWith('!') ? pattern.slice(1) : pattern;
        if (body.startsWith('/') || body.split('/').includes('..')) {
            throw new Error(
                `${DECLARATION_FILE}.include の指定がリポジトリの外を指しています: ${pattern}`,
            );
        }
    }
    const composition = parseComposition(doc.composition, DECLARATION_FILE);
    if (composition) {
        for (const member of composition) {
            if (member.name === doc.name) {
                throw new Error(
                    `構成員に自分自身は書けません。宣言したパッケージは自動で版に含まれます: ${member.ref}`,
                );
            }
        }
    }
    return { name: doc.name, include: doc.include, composition };
}

module.exports = { DECLARATION_FILE, NAME_PATTERN, parseDeclaration };
