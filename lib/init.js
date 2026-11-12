'use strict';

const fs = require('fs');
const path = require('path');
const { git, gitText } = require('./git');
const { DECLARATION_FILE, NAME_PATTERN } = require('./declaration');

// origin の URL からリポジトリ名を引き出す。
function nameFromRemote(root) {
    let url;
    try {
        url = gitText(['remote', 'get-url', 'origin'], { cwd: root });
    } catch {
        return null;
    }
    const cleaned = url.replace(/\.git$/, '').replace(/[/:]$/, '');
    const segment = cleaned.split(/[/:]/).pop();
    return segment || null;
}

// カレントディレクトリに宣言 nap.json を作る。
async function init(nameArg) {
    const root = process.cwd();
    const file = path.join(root, DECLARATION_FILE);
    if (fs.existsSync(file)) {
        throw new Error(`${DECLARATION_FILE} は既にあります。`);
    }
    let inRepo = true;
    try {
        git(['rev-parse', '--git-dir'], { cwd: root });
    } catch {
        inRepo = false;
    }
    const name = (
        nameArg ||
        (inRepo ? nameFromRemote(root) : null) ||
        path.basename(root)
    ).toLowerCase();
    if (!NAME_PATTERN.test(name)) {
        throw new Error(
            `パッケージ名が不正です: ${name}。小文字の英数字と . _ - で書いてください。引数で名前を指定できます`,
        );
    }
    const doc = { name, include: ['**'] };
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    console.log(`${DECLARATION_FILE} を作りました。パッケージ名: ${name}`);
    console.log('include はパッケージに含めるファイルのパターンです。必要に応じて編集してください。');
    if (!inRepo) {
        console.log('このフォルダは Git リポジトリではありません。発行には Git リポジトリが必要です。');
    }
}

module.exports = { init };
