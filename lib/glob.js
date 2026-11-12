'use strict';

function escapeRegExpChar(ch) {
    return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function patternToRegExp(pattern) {
    let source = '';
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === '*') {
            if (pattern[i + 1] === '*') {
                if (pattern[i + 2] === '/') {
                    source += '(?:.*/)?';
                    i += 3;
                } else {
                    source += '.*';
                    i += 2;
                }
            } else {
                source += '[^/]*';
                i += 1;
            }
        } else if (ch === '?') {
            source += '[^/]';
            i += 1;
        } else {
            source += escapeRegExpChar(ch);
            i += 1;
        }
    }
    return new RegExp(`^${source}$`);
}

function compilePattern(pattern) {
    const regex = patternToRegExp(pattern);
    const hasGlob = /[*?]/.test(pattern);
    return (relPath) => {
        if (regex.test(relPath)) return true;
        // ワイルドカードのない指定がフォルダを指す場合は、その中身すべてが対象になる。
        return !hasGlob && relPath.startsWith(`${pattern}/`);
    };
}

function createMatcher(patterns) {
    const includes = [];
    const excludes = [];
    for (const raw of patterns) {
        if (raw.startsWith('!')) excludes.push(compilePattern(raw.slice(1)));
        else includes.push(compilePattern(raw));
    }
    return (relPath) => {
        if (!includes.some((test) => test(relPath))) return false;
        return !excludes.some((test) => test(relPath));
    };
}

module.exports = { createMatcher };
