'use strict';

const fs = require('fs');
const path = require('path');
const { parseDeclaration, DECLARATION_FILE } = require('./declaration');
const { parseGetTarget, dependencyRefFor, isForkDir, MODULES_DIR } = require('./get');
const { askYesNo } = require('./publish');

// 依存関係の記録から、指定した参照を取り除いた宣言のテキストを返す。
// 記録が無ければ null。
function dropDependency(declarationText, ref) {
    const doc = JSON.parse(declarationText);
    if (!Array.isArray(doc.composition)) return null;
    const entryName = (entry) => (typeof entry === 'string' ? entry : entry && entry.name);
    const composition = doc.composition.filter((entry) => entryName(entry) !== ref);
    if (composition.length === doc.composition.length) return null;
    if (composition.length === 0) delete doc.composition;
    else doc.composition = composition;
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    parseDeclaration(text);
    return text;
}

// 導入したパッケージを取り除く。nap_modules の実体と、宣言の記録が対象。
async function remove(specText, options = {}) {
    const cwd = process.cwd();
    const declarationPath = path.join(cwd, DECLARATION_FILE);
    if (!fs.existsSync(declarationPath)) {
        throw new Error(
            `${DECLARATION_FILE} がありません。プロジェクトのフォルダで実行してください。`,
        );
    }
    const { repo, ref: versionRef } = parseGetTarget(specText);
    if (versionRef) {
        throw new Error('版の指定は要りません。');
    }
    const ref = dependencyRefFor(repo);
    const target = path.join(cwd, MODULES_DIR, ref);
    const declarationText = fs.readFileSync(declarationPath, 'utf8');
    const nextText = dropDependency(declarationText, ref);
    const installed = fs.existsSync(target);
    if (!installed && !nextText) {
        throw new Error(`導入されていません: ${ref}`);
    }
    if (installed && isForkDir(target) && !options.yes) {
        const ok = await askYesNo(
            `${ref} はフォークです。作業内容が失われますが、取り除きますか？ [y/N] `,
        );
        if (!ok) {
            console.log('取り除きませんでした。');
            return;
        }
    }
    if (installed) {
        fs.rmSync(target, { recursive: true, force: true });
        // 空になった組織IDのフォルダも片付ける。
        const orgDir = path.dirname(target);
        if (fs.existsSync(orgDir) && fs.readdirSync(orgDir).length === 0) {
            fs.rmdirSync(orgDir);
        }
        const modulesDir = path.join(cwd, MODULES_DIR);
        if (fs.existsSync(modulesDir) && fs.readdirSync(modulesDir).length === 0) {
            fs.rmdirSync(modulesDir);
        }
    }
    if (nextText) fs.writeFileSync(declarationPath, nextText, 'utf8');
    console.log(`取り除きました: ${ref}`);
}

module.exports = { remove, dropDependency };
