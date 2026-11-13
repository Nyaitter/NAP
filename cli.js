#!/usr/bin/env node
'use strict';

const { publish } = require('./lib/publish');
const { get } = require('./lib/get');

const VERSION = require('./package.json').version;

function usage(stream = console.error) {
    stream('使い方: nap <コマンド> [指定] [オプション]');
    stream('');
    stream('  publish  版を作って公開する');
    stream('  init     このフォルダに nap.json を作る');
    stream('  get      版を取り寄せて置く');
    stream('  fork     版の元のリポジトリを作業用に複製する');
    stream('  remove   導入したパッケージを取り除く');
    stream('  list     版の一覧を出す');
    stream('  show     版の内容を見る');
    stream('  search   パッケージを探す');
    stream('');
    stream('ヘルプ: nap <コマンド> --help');
    stream('       nap --version');
}

function commandHelp(command) {
    const helps = {
        publish: [
            '使い方: nap publish [<リポジトリ>] [オプション]',
            'リポジトリの中で実行すると、そのリポジトリの版を作って公開します。',
            '',
            'オプション:',
            '  --ref <コミット|ブランチ>   対象のコミットを変える',
            '  --remote <リモート>         公開先を変える。既定は origin',
            '  --libraries <file.json>     構成員の入手先を渡す',
            '  --test <ラベル>             開発中の版として発行する',
            '  --message <説明>            版の説明を付ける',
            '  --no-push                   版を作るだけで、公開しない',
        ],
        init: [
            '使い方: nap init [<名前>]',
            'このフォルダに nap.json を作ります。名前を省くと、リポジトリの名前から決まります。',
        ],
        get: [
            '使い方: nap get [<所有者>/<リポジトリ>[/<版>]] [オプション]',
            '版を取り寄せて、中身を置きます。版を省くと最新の正式版です。',
            'nap.json のあるフォルダでは導入になり、nap_modules の中に置かれて記録されます。',
            'nap.json のない場所では、リポジトリ名のフォルダへ展開します。',
            '指定がなければ、nap.json に記録されたものをすべて導入します。',
            '',
            'オプション:',
            '  --global, -g     ホームの置き場所へ入れる',
            '  --out <場所>     展開先を指定する',
        ],
        fork: [
            '使い方: nap fork <所有者>/<リポジトリ>[/<版>]',
            '元のリポジトリを複製して、nap_modules の中に作業用のコピーを置きます。',
        ],
        remove: [
            '使い方: nap remove <所有者>/<リポジトリ> [--yes]',
            '導入したパッケージと、nap.json の記録を取り除きます。',
            '',
            'オプション:',
            '  --yes   確認なしで取り除く',
        ],
        list: [
            '使い方: nap list [<所有者>/<リポジトリ>]',
            '版の一覧を出します。対象を省くと、このリポジトリの一覧になります。',
        ],
        show: [
            '使い方: nap show [<版>] [--repo <所有者>/<リポジトリ>]',
            '版の内容を見ます。版を省くと最新の正式版です。版IDの先頭や版コードでも指定できます。',
            '',
            'オプション:',
            '  --repo <所有者>/<リポジトリ>   対象を指定する',
        ],
        search: [
            '使い方: nap search [キーワード...] [--limit <件数>]',
            'nap.json を持つリポジトリを探します。GITHUB_TOKEN の設定が必要です。',
        ],
    };
    const lines = helps[command];
    if (!lines) return false;
    for (const line of lines) console.log(line);
    return true;
}

// オプションを読む。flags は値を取らないもの。
// --key value と --key=value の両方の書式を受け、-x の短縮も受けられる。
function parseOptions(args, allowed, flags = []) {
    const positional = [];
    const options = {};
    for (let i = 0; i < args.length; i++) {
        let arg = args[i];
        if (arg.startsWith('--')) {
            let key = arg.slice(2);
            let value;
            const eq = key.indexOf('=');
            if (eq >= 0) {
                value = key.slice(eq + 1);
                key = key.slice(0, eq);
            }
            if (!allowed.includes(key)) return { error: `不明なオプションです: ${arg}` };
            if (flags.includes(key)) {
                options[key] = true;
                continue;
            }
            if (value === undefined) {
                value = args[++i];
                if (value === undefined) return { error: `オプションには値が必要です: ${arg}` };
            }
            options[key] = value;
        } else if (arg.startsWith('-') && arg.length > 1) {
            const shorts = arg.slice(1);
            for (const ch of shorts) {
                const key = SHORT_OPTIONS[ch];
                if (!key) return { error: `不明なオプションです: ${arg}` };
                if (flags.includes(key)) options[key] = true;
                else {
                    const value = args[++i];
                    if (value === undefined) return { error: `オプションには値が必要です: -${ch}` };
                    options[key] = value;
                }
            }
        } else {
            positional.push(arg);
        }
    }
    return { positional, options };
}

const SHORT_OPTIONS = { g: 'global', h: 'help' };

function fail(message, code = 2) {
    console.error(message);
    process.exitCode = code;
}

async function main(argv) {
    const [command, ...rest] = argv;
    if (command === undefined || command === '--help' || command === '-h') {
        usage();
        return command === undefined ? 2 : 0;
    }
    if (command === '--version' || command === '-v') {
        console.log(`nap ${VERSION}`);
        return 0;
    }
    if (command.startsWith('-')) {
        fail(`不明なコマンドです: ${command}`);
        usage();
        return 2;
    }
    if (rest.includes('--help') || rest.includes('-h')) {
        if (commandHelp(command)) return 0;
        fail(`不明なコマンドです: ${command}`);
        usage();
        return 2;
    }

    if (command === 'publish') {
        const { positional, options, error } = parseOptions(rest, [
            'ref',
            'remote',
            'libraries',
            'chunk-size',
            'test',
            'message',
            'no-push',
        ], ['no-push']);
        if (error || positional.length > 1) {
            if (error) fail(error);
            else fail('指定が多すぎます。');
            commandHelp('publish');
            return 2;
        }
        const { ensureGit } = require('./lib/git');
        ensureGit();
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
            noPush: Boolean(options['no-push']),
        });
        return 0;
    }
    if (command === 'list') {
        const { list } = require('./lib/inspect');
        const { positional, options, error } = parseOptions(rest, ['remote'], []);
        if (error || positional.length > 1) {
            if (error) fail(error);
            else {
                fail('指定が多すぎます。');
            }
            commandHelp('list');
            return 2;
        }
        await list(positional[0], { remote: options.remote });
        return 0;
    }
    if (command === 'show') {
        const { show } = require('./lib/inspect');
        const { positional, options, error } = parseOptions(rest, ['repo', 'remote'], []);
        if (error || positional.length > 1) {
            if (error) fail(error);
            else fail('指定が多すぎます。');
            commandHelp('show');
            return 2;
        }
        await show(positional[0], { repo: options.repo, remote: options.remote });
        return 0;
    }
    if (command === 'init') {
        if (rest.length > 1 || (rest.length === 1 && rest[0].startsWith('-'))) {
            fail('指定が多すぎます。');
            commandHelp('init');
            return 2;
        }
        const { ensureGit } = require('./lib/git');
        ensureGit();
        const { init } = require('./lib/init');
        await init(rest[0]);
        return 0;
    }
    if (command === 'get') {
        const { positional, options, error } = parseOptions(
            rest,
            ['out', 'global'],
            ['global'],
        );
        if (error || positional.length > 1) {
            if (error) fail(error);
            else fail('指定が多すぎます。');
            commandHelp('get');
            return 2;
        }
        await get(positional[0], { out: options.out, global: Boolean(options.global) });
        return 0;
    }
    if (command === 'fork') {
        const { fork } = require('./lib/fork');
        const { ensureGit } = require('./lib/git');
        ensureGit();
        const { positional, options, error } = parseOptions(rest, [], []);
        if (error || positional.length !== 1 || Object.keys(options).length > 0) {
            if (error) fail(error);
            else if (positional.length !== 1) fail('対象を1つ指定してください。');
            commandHelp('fork');
            return 2;
        }
        await fork(positional[0]);
        return 0;
    }
    if (command === 'remove') {
        const { remove } = require('./lib/remove');
        const { positional, options, error } = parseOptions(rest, ['yes'], ['yes']);
        if (error || positional.length !== 1) {
            if (error) fail(error);
            else fail('対象を1つ指定してください。');
            commandHelp('remove');
            return 2;
        }
        await remove(positional[0], { yes: Boolean(options.yes) });
        return 0;
    }
    if (command === 'search') {
        const { search } = require('./lib/search');
        const { positional, options, error } = parseOptions(rest, ['limit'], []);
        if (error) {
            fail(error);
            commandHelp('search');
            return 2;
        }
        const limit = options.limit !== undefined ? Number(options.limit) : 20;
        await search(positional, { limit });
        return 0;
    }
    fail(`不明なコマンドです: ${command}`);
    usage();
    return 2;
}

main(process.argv.slice(2)).then(
    (code) => {
        process.exitCode = code;
    },
    (error) => {
        if (error && error.detail) {
            console.error(error.message);
        } else {
            console.error(error instanceof Error ? error.message : error);
        }
        process.exitCode = 1;
    },
);
