'use strict';

// 1行のプログレスバー。端末のときだけ表示し、完了したら行を空けて終わる。
// 端末でないときは何も出さない。出力はリダイレクトに紛れないようにする。

const BAR_WIDTH = 24;

function isTTY() {
    return Boolean(process.stdout.isTTY && process.stderr.isTTY);
}

function fit(text, width) {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= width) return text;
    let out = text;
    while (Buffer.byteLength(out, 'utf8') > width - 1) out = out.slice(0, -1);
    return `${out}…`;
}

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function createProgressBar(label) {
    if (!isTTY()) {
        return {
            update() {},
            message() {},
            done() {},
        };
    }
    let last = '';
    let finished = false;
    const render = (text) => {
        if (finished || text === last) return;
        last = text;
        process.stderr.write(`\r${fit(text, process.stdout.columns || 80)}\x1b[K`);
    };
    return {
        update(fraction, detail) {
            const ratio = Math.max(0, Math.min(1, Number(fraction) || 0));
            const filled = Math.round(ratio * BAR_WIDTH);
            const bar = `${'#'.repeat(filled)}${'-'.repeat(BAR_WIDTH - filled)}`;
            const percent = `${Math.floor(ratio * 100)}%`;
            render(
                `  ${label} [${bar}] ${percent}${detail ? ` ${detail}` : ''}`,
            );
        },
        message(text) {
            render(`  ${label} ${text}`);
        },
        done(text) {
            if (finished) return;
            finished = true;
            process.stderr.write('\r\x1b[K');
            if (text !== undefined) process.stderr.write(`  ${label} ${text}\n`);
        },
    };
}

module.exports = { createProgressBar, formatBytes };
