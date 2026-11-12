#!/usr/bin/env node
'use strict';

const { publish } = require('./lib/publish');
const { list, show } = require('./lib/inspect');
const { get } = require('./lib/get');
const { search } = require('./lib/search');

function usage() {
    console.error('使い方:');
    console.error('  nap publish [<リポジトリ>] [--ref <コミット|ブランチ>] [--remote <リモート>] [--libraries <file.json>] [--test <ラベル>] [--message <説明>] [--no-push]\n  nap init [<名前>]');
    console.error('  nap list [<リポジトリ>] [--remote <リモート>]');
    console.error('  nap show [<版ID>] [--repo <リポジトリ>] [--remote <リモート>]');
    console.error('  nap get [<指定>] [--out <出力先>]');
    console.error('  nap fork <指定>\n  nap remove <指定> [--yes]');
    console.error('  nap search [キーワード...] [--limit <件数>]');
    console.error('publish は、リポジトリの中で実行するとそのリポジトリを対象にします。');
}

function parseOptions(args, allowed) {
    const positional = [];
    const options = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const key = arg.slice(2);
            if (!allowed.includes(key)) return { error: `不明なオプションです: ${arg}` };
            const value = args[++i];
            if (value === undefined) return { error: `オプションには値が必要です: ${arg}` };
            options[key] = value;
        } else {
            positional.push(arg);
        }
    }
    return { positional, options };
}

async function main(argv) {
    const [command, ...rest] = argv;
    if (command === 'publish') {
        const noPush = rest.includes('--no-push');
        const publishArgs = rest.filter((a) => a !== '--no-push');
        const { positional, options, error } = parseOptions(publishArgs, [
            'ref',
            'remote',
            'libraries',
            'chunk-size',
            'test',
            'message',
        ]);
        if (error || positional.length > 1) {
            if (error) console.error(error);
            usage();
            return 2;
        }
        const chunkSize =
            options['chunk-size'] !== undefined
                ? Number(options['chunk-size'])
                : Number(process.env.NAP_CHUNK_SIZE || 200);
        await publish(positional[0], {
            ref: options.ref,
            remote: options.remote,
            libraries: options.libraries,
            chunkSize,
            test: options.test,
            message: options.message,
            noPush,
        });
        return 0;
    }
    if (command === 'list') {
        const { positional, options, error } = parseOptions(rest, ['remote']);
        if (error || positional.length > 1) {
            if (error) console.error(error);
            usage();
            return 2;
        }
        await list(positional[0], { remote: options.remote });
        return 0;
    }
    if (command === 'show') {
        const { positional, options, error } = parseOptions(rest, ['repo', 'remote']);
        if (error || positional.length > 1) {
            if (error) console.error(error);
            usage();
            return 2;
        }
        await show(positional[0], { repo: options.repo, remote: options.remote });
        return 0;
    }
    if (command === 'init') {
        if (rest.length > 1 || (rest.length === 1 && rest[0].startsWith('-'))) {
            usage();
            return 2;
        }
        const { init } = require('./lib/init');
        await init(rest[0]);
        return 0;
    }

    if (command === 'get') {
        const { positional, options, error } = parseOptions(rest, ['out']);
        if (error || positional.length > 1) {
            if (error) console.error(error);
            usage();
            return 2;
        }
        await get(positional[0], { out: options.out });
        return 0;
    }
    if (command === 'fork') {
        const { fork } = require('./lib/fork');
        const { positional, options, error } = parseOptions(rest, []);
        if (error || positional.length !== 1 || Object.keys(options).length > 0) {
            if (error) console.error(error);
            usage();
            return 2;
        }
        await fork(positional[0]);
        return 0;
    }
    if (command === 'remove') {
        const yes = rest.includes('--yes');
        const removeArgs = rest.filter((a) => a !== '--yes');
        if (removeArgs.length !== 1) {
            usage();
            return 2;
        }
        const { remove } = require('./lib/remove');
        await remove(removeArgs[0], { yes });
        return 0;
    }

    if (command === 'search') {
        const { positional, options, error } = parseOptions(rest, ['limit']);
        if (error) {
            console.error(error);
            usage();
            return 2;
        }
        const limit = options.limit !== undefined ? Number(options.limit) : 20;
        await search(positional, { limit });
        return 0;
    }
    usage();
    return 2;
}

main(process.argv.slice(2)).then(
    (code) => {
        process.exitCode = code;
    },
    (error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    },
);
