'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { git, gitText, refExists } = require('./git');
const {
    MANIFEST_NAME,
    VERSIONS_BRANCH,
    INDEX_BRANCH,
    INDEX_TAG,
    sha256Hex,
    packageIdOf,
    versionIdOf,
    manifestBuffer,
    validateLabel,
    tagRefFor,
    isSourceSpec,
    deriveVersionCode,
    parseManifest,
} = require('./core');
const { MODULES_DIR } = require('./get');
const { DECLARATION_FILE, parseDeclaration } = require('./declaration');
const { createMatcher } = require('./glob');
const { readIndexAt } = require('./read');

const COMMITTER_ENV = {
    GIT_AUTHOR_NAME: 'nap',
    GIT_AUTHOR_EMAIL: 'nap@localhost',
    GIT_COMMITTER_NAME: 'nap',
    GIT_COMMITTER_EMAIL: 'nap@localhost',
};
const DEFAULT_CHUNK_SIZE = 200;

function resolveRepoRoot(spec) {
    const dir = spec ? path.resolve(spec) : process.cwd();
    return gitText(['rev-parse', '--show-toplevel'], { cwd: dir });
}

function readBlobAt(root, commit, rel) {
    try {
        return git(['cat-file', 'blob', `${commit}:${rel}`], { cwd: root });
    } catch {
        return null;
    }
}

// 対象コミットのツリーから、宣言に一致するファイルのハッシュとオブジェクトIDを集める。
// 宣言ファイルとマニフェスト自身は対象に含めない。
function snapshotFiles(root, commit, include) {
    const matcher = createMatcher(include);
    const out = git(['ls-tree', '-r', '-z', commit], { cwd: root });
    const files = {};
    const objects = {};
    for (const record of out.toString('utf8').split('\0')) {
        if (!record) continue;
        const tab = record.indexOf('\t');
        const [mode, type, oid] = record.slice(0, tab).split(' ');
        const rel = record.slice(tab + 1);
        if (type !== 'blob') continue;
        if (mode !== '100644' && mode !== '100755') continue;
        if (rel === DECLARATION_FILE || rel === MANIFEST_NAME) continue;
        if (!matcher(rel)) continue;
        const content = git(['cat-file', 'blob', oid], { cwd: root });
        files[rel] = sha256Hex(content);
        objects[rel] = { oid, mode };
    }
    return { files, objects };
}

// リモートにブランチがあれば取り込む。無い場合はここから作る。
function fetchBranch(root, remote, branch) {
    let exists = false;
    try {
        exists =
            gitText(['ls-remote', remote, `refs/heads/${branch}`], { cwd: root }).length > 0;
    } catch {
        exists = false;
    }
    if (!exists) return;
    git(['fetch', '--quiet', remote, `+refs/heads/${branch}:refs/heads/${branch}`], {
        cwd: root,
    });
}

// 索引を取り寄せる。リモートではタグ nap-index にあり、移行前の
// リポジトリではブランチ nap/index にある。どちらもローカルの
// refs/heads/nap/index へ入れる。
function fetchIndex(root, remote) {
    let tagExists = false;
    try {
        tagExists =
            gitText(['ls-remote', remote, `refs/tags/${INDEX_TAG}`], { cwd: root }).length > 0;
    } catch {
        tagExists = false;
    }
    if (tagExists) {
        git(
            ['fetch', '--quiet', '--force', remote, `+refs/tags/${INDEX_TAG}:refs/heads/${INDEX_BRANCH}`],
            { cwd: root },
        );
        return;
    }
    fetchBranch(root, remote, INDEX_BRANCH);
}

// 出典を含むブランチを返す。出典は対象コミットのこと。
// --ref で指定されたブランチを優先し、次に現在のブランチを見る。
// どちらにも含まれなければ null。
function sourceBranchFor(root, ref, commit) {
    const candidates = [];
    if (ref) candidates.push(ref);
    try {
        candidates.push(gitText(['symbolic-ref', '--short', 'HEAD'], { cwd: root }));
    } catch {
        // detached HEAD では現在のブランチは無い
    }
    for (const name of candidates) {
        let tip;
        try {
            tip = gitText(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd: root });
        } catch {
            continue;
        }
        if (tip === commit) return name;
        try {
            git(['merge-base', '--is-ancestor', commit, `refs/heads/${name}`], { cwd: root });
            return name;
        } catch {
            // このブランチには含まれていない
        }
    }
    return null;
}

// 出典を含むブランチを push する。版が公開される時点で中身は出ているため、
// 出典も辿れるよう同時に公開するのが既定。
function pushSourceBranch(root, remote, ref, commit) {
    const branch = sourceBranchFor(root, ref, commit);
    if (!branch) return;
    git(['push', '--quiet', remote, `${branch}:${branch}`], { cwd: root });
    console.log(`出典を含むブランチ ${branch} を ${remote} へ push しました`);
}

function remoteTagTarget(root, remote, tagRef) {
    let out = '';
    try {
        out = gitText(['ls-remote', remote, `refs/tags/${tagRef}`], { cwd: root });
    } catch {
        return null;
    }
    if (!out) return null;
    return out.split(/\s+/)[0];
}

// 一時インデックスでツリーを組み立てる。
function buildTree(root, baseTree, entries, blobs) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nap-index-'));
    const indexFile = path.join(tmp, 'index');
    const env = { GIT_INDEX_FILE: indexFile };
    try {
        if (baseTree) git(['read-tree', baseTree], { cwd: root, env });
        else git(['read-tree', '--empty'], { cwd: root, env });
        for (const { mode, oid, rel } of entries) {
            git(['update-index', '--add', '--cacheinfo', `${mode},${oid},${rel}`], {
                cwd: root,
                env,
            });
        }
        for (const [rel, content] of Object.entries(blobs)) {
            const blob = gitText(['hash-object', '-w', '--stdin'], {
                cwd: root,
                env,
                input: content,
            });
            git(['update-index', '--add', '--cacheinfo', `100644,${blob},${rel}`], {
                cwd: root,
                env,
            });
        }
        return gitText(['write-tree'], { cwd: root, env });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

function commitTree(root, tree, parents, message) {
    const args = ['commit-tree', tree];
    for (const parent of parents) {
        if (parent) args.push('-p', parent);
    }
    return gitText(args, { cwd: root, env: COMMITTER_ENV, input: Buffer.from(message) });
}

function chunkFileName(index) {
    return `chunk-${String(index).padStart(4, '0')}.json`;
}

// 索引へ書く1件。tag はラベルのことで、TestVersion のときだけ持つ。
function indexRecord(entry) {
    const record = { id: entry.id, commit: entry.commit, at: entry.at };
    if (entry.tag) record.tag = entry.tag;
    if (entry.source) record.source = entry.source;
    if (entry.code) record.code = entry.code;
    return record;
}

// 索引へ1件追加するコミットを作って push する。既にあれば何もしない。
// 同じ版IDでも、正式版と TestVersion、ラベルの違う TestVersion は別の件として扱う。
function appendIndex(root, remote, entry, chunkSize, push = true) {
    const ref = `refs/heads/${INDEX_BRANCH}`;
    const { head, entries } = readIndexAt(root, ref);
    if (entries.some((e) => e.id === entry.id && (e.tag || null) === (entry.tag || null))) {
        return false;
    }

    const chunks = head.chunks.map((c) => ({ file: c.file, count: c.count }));
    let targetFile;
    let targetEntries;
    if (chunks.length > 0 && chunks[chunks.length - 1].count < chunkSize) {
        targetFile = chunks[chunks.length - 1].file;
        targetEntries = entries.filter((e) => e.chunkFile === targetFile);
        chunks[chunks.length - 1].count += 1;
    } else {
        targetFile = chunkFileName(chunks.length + 1);
        targetEntries = [];
        chunks.push({ file: targetFile, count: 1 });
    }
    targetEntries.push(entry);

    const newHead = { chunks, total: head.total + 1 };
    const blobs = {
        'index.json': Buffer.from(`${JSON.stringify(newHead, null, 2)}\n`, 'utf8'),
        [targetFile]: Buffer.from(
            `${JSON.stringify(targetEntries.map(indexRecord), null, 2)}\n`,
            'utf8',
        ),
    };
    const baseTree = refExists(root, ref) ? gitText(['rev-parse', `${ref}^{tree}`], { cwd: root }) : null;
    const tree = buildTree(root, baseTree, [], blobs);
    const parent = refExists(root, ref) ? gitText(['rev-parse', ref], { cwd: root }) : null;
    const label = entry.tag ? `-${entry.tag}` : '';
    const commit = commitTree(root, tree, parent ? [parent] : [], `index: add ${entry.id.slice(0, 12)}${label}\n`);
    git(['update-ref', ref, commit], { cwd: root });
    if (push) {
        git(['push', '--force', '--quiet', remote, `${ref}:refs/tags/${INDEX_TAG}`], { cwd: root });
    }
    return true;
}

// 構成員の解決元を読み込む。解決元は --libraries の JSON。
// { "<組織ID>/<名前>": { "repo": "<マニフェストに残すソース>", "version"?: "<版ID>", "source"?: "<パス|URL>" } }
function readLibrariesSpec(specPath) {
    if (!specPath) return {};
    let doc;
    try {
        doc = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    } catch (error) {
        throw new Error(`--libraries のファイルが読めません: ${error.message}`);
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new Error('--libraries の形式が不正です。オブジェクトで書いてください。');
    }
    return doc;
}

function isUrlSpec(spec) {
    return /^(?:https?|ssh|git):\/\//.test(spec) || spec.startsWith('git@') || spec.startsWith('file://');
}

// 構成員のリポジトリを開く。ローカルパスはそのまま、URL は一時クローン。
function openLibraryRepo(source) {
    if (!isUrlSpec(source) && fs.existsSync(source)) {
        const dir = path.resolve(source);
        gitText(['rev-parse', '--show-toplevel'], { cwd: dir });
        return { dir, cleanup: () => {} };
    }
    if (isUrlSpec(source)) {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nap-lib-'));
        const dir = path.join(tmp, 'repo');
        git(['clone', '--quiet', source, dir], {});
        return {
            dir,
            cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
        };
    }
    throw new Error(`構成員のリポジトリを開けません: ${source}`);
}

// 構成員の最新版を、そのリポジトリの索引から解決する。
// 解決するのは正式版だけであり、TestVersion は対象にしない。
function resolveLatestVersion(source, ref) {
    const { dir, cleanup } = openLibraryRepo(source);
    try {
        let remoteIndexRef = null;
        try {
            if (
                gitText(['ls-remote', 'origin', `refs/tags/${INDEX_TAG}`], { cwd: dir }).length > 0
            ) {
                remoteIndexRef = `refs/tags/${INDEX_TAG}`;
            } else if (
                gitText(['ls-remote', 'origin', `refs/heads/${INDEX_BRANCH}`], { cwd: dir })
                    .length > 0
            ) {
                remoteIndexRef = `refs/heads/${INDEX_BRANCH}`;
            }
        } catch {
            remoteIndexRef = null;
        }
        if (remoteIndexRef) {
            git(
                [
                    'fetch',
                    '--quiet',
                    '--force',
                    'origin',
                    `+${remoteIndexRef}:refs/nap-resolve/${INDEX_BRANCH}`,
                ],
                { cwd: dir },
            );
        }
        const candidates = [
            `refs/nap-resolve/${INDEX_BRANCH}`,
            `refs/heads/${INDEX_BRANCH}`,
            `refs/remotes/origin/${INDEX_BRANCH}`,
        ];
        for (const candidate of candidates) {
            const { entries } = readIndexAt(dir, candidate);
            if (entries.length === 0) continue;
            const formal = entries.filter((e) => !e.tag);
            if (formal.length > 0) return formal[formal.length - 1].id;
            throw new Error(
                `構成員 ${ref} には正式版がまだありません。開発中の版だけが発行されています。`,
            );
        }
        throw new Error(`構成員 ${ref} にはまだ発行された版がありません。`);
    } finally {
        cleanup();
    }
}

// 導入済みの構成員を対象コミットのツリーから確かめる。導入済みとは nap_modules に実物があること。
// 導入時のマニフェストとツリー内の実物のハッシュが一致すること、宣言で版が
// 固定されていればその版であることを確認する。戻り値は { "<参照>": "<版ID>" }。
function readInstalledMembers(root, commit, declaration, snapshot) {
    const bundled = {};
    if (!declaration.composition) return bundled;
    for (const member of declaration.composition) {
        const base = `${MODULES_DIR}/${member.ref}`;
        const manifestText = readBlobAt(root, commit, `${base}/version-manifest.json`);
        if (manifestText === null) continue;
        let installed;
        try {
            installed = parseManifest(manifestText);
        } catch (error) {
            throw new Error(
                `導入済みの構成員 ${member.ref} のマニフェストが読めません: ${error.message}`,
            );
        }
        const installedId = versionIdOf(installed.files, installed.libraries);
        if (member.version && member.version !== installedId) {
            throw new Error(
                `導入済みの構成員 ${member.ref} の版 ${installedId} が、宣言で固定された版 ${member.version} と違います。`,
            );
        }
        for (const [rel, hash] of Object.entries(installed.files)) {
            const full = `${base}/${rel}`;
            if (!(full in snapshot)) {
                throw new Error(
                    `導入済みの構成員 ${member.ref} のファイルが発行対象に含まれていません: ${full}。include を確認してください`,
                );
            }
            if (snapshot[full] !== hash) {
                throw new Error(
                    `導入済みの構成員 ${member.ref} の内容が、導入時の版と一致しません: ${full}`,
                );
            }
        }
        bundled[member.ref] = installedId;
    }
    return bundled;
}

// マニフェストの libraries から、入れ子の構成員の一覧を取り出す。
function nestedMembers(manifest) {
    return Object.entries(manifest.libraries || {}).map(([ref, lib]) => ({
        ref,
        version: lib.version,
        repo: lib.repo,
    }));
}

// 作業ツリーの nap_modules にある導入済みコピーを読む。版が一致し、
// 実物のハッシュがマニフェストと一致する場合だけ使う。キャッシュ扱い。
function readWorktreeCopy(root, ref, version) {
    const dir = path.join(root, MODULES_DIR, ref);
    const manifestPath = path.join(dir, 'version-manifest.json');
    if (!fs.existsSync(manifestPath)) return null;
    let manifest;
    try {
        manifest = parseManifest(fs.readFileSync(manifestPath));
    } catch {
        return null;
    }
    if (versionIdOf(manifest.files, manifest.libraries) !== version) return null;
    const files = {};
    for (const [rel, hash] of Object.entries(manifest.files)) {
        const filePath = path.join(dir, rel);
        if (!fs.existsSync(filePath)) return null;
        const content = fs.readFileSync(filePath);
        if (sha256Hex(content) !== hash) return null;
        files[rel] = content;
    }
    return { manifest, files, nested: nestedMembers(manifest) };
}

// ローカルのリポジトリから版のツリーを読む。リポジトリはパスまたは URL で指定する。
function readVersionFromRepo(source, ref, version) {
    const { dir, cleanup } = openLibraryRepo(source);
    try {
        let commit;
        try {
            commit = gitText(['rev-parse', `refs/tags/${tagRefFor(version, null)}^{commit}`], {
                cwd: dir,
            });
        } catch {
            return null;
        }
        const manifestText = readBlobAt(dir, commit, MANIFEST_NAME);
        if (manifestText === null) return null;
        const manifest = parseManifest(manifestText);
        if (versionIdOf(manifest.files, manifest.libraries) !== version) {
            throw new Error(`構成員 ${ref} の版が一致しません: ${source}`);
        }
        const files = {};
        for (const rel of Object.keys(manifest.files)) {
            const content = readBlobAt(dir, commit, rel);
            if (content === null) {
                throw new Error(`構成員 ${ref} のファイルが版のツリーにありません: ${rel}`);
            }
            files[rel] = content;
        }
        return { manifest, files, nested: nestedMembers(manifest) };
    } finally {
        cleanup();
    }
}

// フォーク済みの導入コピーを読む。Git で追跡されているファイルと
// 未追跡のファイルについて、作業ツリーの現在の内容を使う。無視対象は除く。
// version-manifest.json は生成物なので含めない。
function readForkCopy(root, ref) {
    const dir = path.join(root, MODULES_DIR, ref);
    const listed = git(
        ['-C', dir, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        {},
    )
        .toString('utf8')
        .split('\0')
        .filter(Boolean);
    const files = {};
    for (const rel of listed) {
        if (rel === MANIFEST_NAME) continue;
        files[rel] = fs.readFileSync(path.join(dir, rel));
    }
    const manifest = { files: {}, libraries: {} };
    for (const [rel, content] of Object.entries(files)) {
        manifest.files[rel] = sha256Hex(content);
    }
    return {
        manifest,
        files,
        version: versionIdOf(manifest.files, manifest.libraries),
        fork: true,
    };
}

// 構成員1件の内容を用意する。フォーク、作業ツリーの導入済みコピー、
// ローカルのリポジトリ、ネットワーク取得の順に試す。
async function obtainMember(root, ref, version, entry, repoHint) {
    if (fs.existsSync(path.join(root, MODULES_DIR, ref, '.git'))) {
        return readForkCopy(root, ref);
    }
    const cached = readWorktreeCopy(root, ref, version);
    if (cached) return cached;
    const source = entry.source || null;
    if (source && (fs.existsSync(source) || isUrlSpec(source))) {
        const fromRepo = readVersionFromRepo(source, ref, version);
        if (fromRepo) return fromRepo;
    }
    const repo = entry.repo || repoHint || ref;
    const { createClient } = await import('../client/nap-client.js');
    const client = createClient({ rawBase: process.env.NAP_RAW_BASE || undefined });
    const result = await client.fetchVersion(repo, version);
    return { manifest: result.manifest, files: result.files, materialized: result.libraries };
}

function placeFiles(ref, manifest, files, state) {
    const base = `${MODULES_DIR}/${ref}`;
    for (const [rel, content] of Object.entries(files)) {
        const full = `${base}/${rel}`;
        if (full in state.snapshot || full in state.blobs) {
            throw new Error(`発行対象に既にあるファイルと競合します: ${full}`);
        }
        state.blobs[full] = content;
    }
    state.blobs[`${base}/version-manifest.json`] = Buffer.from(
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
    );
}

// 取得済みのパッケージをそのまま埋め込む。形は fetchVersion の結果と同じ。
async function placeMaterialized(ref, pkg, state) {
    if (state.versions.has(ref)) {
        if (state.versions.get(ref) !== pkg.versionId) {
            throw new Error(`構成員 ${ref} の版が競合しています。`);
        }
        return;
    }
    state.versions.set(ref, pkg.versionId);
    placeFiles(ref, pkg.manifest, pkg.files, state);
    for (const [nestedRef, nestedPkg] of Object.entries(pkg.libraries || {})) {
        await placeMaterialized(nestedRef, nestedPkg, state);
    }
}

// 構成員を版へ埋め込む。版は、宣言の固定 → --libraries の固定 →
// 解決元の索引の最新、の順で決める。1件でも用意できない場合は例外にする。
async function embedMember(root, ref, pinnedVersion, repoHint, spec, state) {
    if (state.versions.has(ref)) {
        if (pinnedVersion && state.versions.get(ref) !== pinnedVersion) {
            throw new Error(`構成員 ${ref} の版が競合しています。`);
        }
        return;
    }
    const entry = spec[ref] || {};
    if (entry.repo !== undefined && !isSourceSpec(entry.repo)) {
        throw new Error(
            `構成員 ${ref} の repo は「<所有者>/<リポジトリ>」で指定してください: ${entry.repo}`,
        );
    }
    let version = pinnedVersion || entry.version || null;
    if (!version) {
        const source = entry.source || entry.repo;
        if (!source) {
            throw new Error(
                `構成員 ${ref} の解決元が --libraries にありません。repo が必要です。`,
            );
        }
        version = resolveLatestVersion(source, ref);
    }
    const pkg = await obtainMember(root, ref, version, entry, repoHint);
    state.versions.set(ref, pkg.version || version);
    if (pkg.fork) state.forks.add(ref);
    placeFiles(ref, pkg.manifest, pkg.files, state);
    if (pkg.materialized) {
        for (const [nestedRef, nestedPkg] of Object.entries(pkg.materialized)) {
            await placeMaterialized(nestedRef, nestedPkg, state);
        }
    } else {
        for (const nested of pkg.nested || []) {
            await embedMember(root, nested.ref, nested.version, nested.repo, spec, state);
        }
    }
}

// 標準入力で y/n を尋ねる。1行読む。EOF の場合は no として扱う。
function askYesNo(question) {
    process.stdout.write(question);
    return new Promise((resolve) => {
        const stdin = process.stdin;
        let buffer = '';
        let settled = false;
        const finish = (line) => {
            if (settled) return;
            settled = true;
            stdin.pause();
            resolve(/^y(es)?$/i.test((line || '').trim()));
        };
        stdin.on('data', (chunk) => {
            buffer += chunk;
            const at = buffer.indexOf('\n');
            if (at >= 0) finish(buffer.slice(0, at));
        });
        stdin.on('end', () => finish(buffer));
        stdin.on('error', () => finish(''));
        stdin.resume();
    });
}

// 指定したリポジトリの HEAD を発行した場合の版IDを、発行せずに計算する。
async function computeVersionIdAtHead(root, options) {
    const commit = gitText(['rev-parse', 'HEAD^{commit}'], { cwd: root });
    const declarationText = readBlobAt(root, commit, DECLARATION_FILE);
    if (declarationText === null) {
        throw new Error(`対象コミットにパッケージの宣言 ${DECLARATION_FILE} がありません。`);
    }
    const declaration = parseDeclaration(declarationText.toString('utf8'));
    const { files } = snapshotFiles(root, commit, declaration.include);
    const bundled = readInstalledMembers(root, commit, declaration, files);
    const state = {
        blobs: {},
        versions: new Map(Object.entries(bundled)),
        snapshot: files,
        forks: new Set(),
    };
    if (declaration.composition) {
        const spec = readLibrariesSpec(options.libraries);
        for (const member of declaration.composition) {
            if (state.versions.has(member.ref)) continue;
            await embedMember(root, member.ref, member.version, null, spec, state);
        }
    }
    for (const [rel, content] of Object.entries(state.blobs)) {
        files[rel] = sha256Hex(content);
    }
    return versionIdOf(files, {});
}

// 変更のあるフォークの一覧を返す。変更があるとは、未コミットの変更があるか、
// HEAD の内容がまだ発行されていないこと。
async function changedForks(root, embedState, options) {
    const changed = [];
    for (const ref of embedState.forks) {
        const dir = path.join(root, MODULES_DIR, ref);
        const status = gitText(['-C', dir, 'status', '--porcelain'], {});
        if (status.trim().length > 0) {
            changed.push(ref);
            continue;
        }
        let unpublished;
        try {
            const headId = await computeVersionIdAtHead(dir, options);
            const label = options.test !== undefined ? validateLabel(options.test) : null;
            unpublished = !refExists(dir, `refs/tags/${tagRefFor(headId, label)}`);
        } catch {
            unpublished = true;
        }
        if (unpublished) changed.push(ref);
    }
    return changed;
}

// 変更のあるフォークがあれば確認し、了承されたら一緒に発行する。
// フォーク側に未コミットの変更があれば、先にコミットする。
async function publishChangedForks(root, embedState, options) {
    const changed = await changedForks(root, embedState, options);
    if (changed.length === 0) return;
    console.log(`変更のあるフォーク: ${changed.join(', ')}`);
    const yes = await askYesNo('フォークの変更も一緒に発行しますか？ [y/N] ');
    if (!yes) {
        console.log('フォークは発行しませんでした。内容はこの版に含まれます。');
        return;
    }
    for (const ref of changed) {
        const dir = path.join(root, MODULES_DIR, ref);
        const status = gitText(['-C', dir, 'status', '--porcelain'], {});
        if (status.trim().length > 0) {
            git(['-C', dir, 'add', '-A'], {});
            git(['-C', dir, 'commit', '--quiet', '-m', 'fork: changes'], { env: COMMITTER_ENV });
        }
        console.log(`フォークを発行します: ${ref}`);
        await publish(dir, { ...options, skipForks: true, message: undefined });
    }
}

async function publish(repoSpec, options = {}) {
    const remote = options.remote || 'origin';
    // 公開先が書けないと後で必ず失敗するため、最初に確かめる。
    const rootForCheck = resolveRepoRoot(repoSpec);
    try {
        gitText(['remote', 'get-url', remote], { cwd: rootForCheck });
    } catch {
        throw new Error(`公開先の ${remote} が見つかりません。--remote で指定してください。`);
    }
    const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
    const testLabel = options.test !== undefined ? validateLabel(options.test) : null;
    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
        throw new Error(`チャンクサイズが不正です: ${chunkSize}`);
    }
    const root = resolveRepoRoot(repoSpec);
    const commit = gitText(['rev-parse', `${options.ref || 'HEAD'}^{commit}`], { cwd: root });

    const declarationText = readBlobAt(root, commit, DECLARATION_FILE);
    if (declarationText === null) {
        throw new Error(`対象コミットにパッケージの宣言 ${DECLARATION_FILE} がありません。`);
    }
    const declaration = parseDeclaration(declarationText.toString('utf8'));

    const { files, objects } = snapshotFiles(root, commit, declaration.include);
    if (Object.keys(files).length === 0) {
        throw new Error(`対象ファイルが1つもありません: ${declaration.name}`);
    }

    // 構成員は版へ埋め込む。マニフェストの libraries には入れない。
    // コミット内に導入済みのものは実物を照合して使い、残りは固定された版を
    // 取り寄せる。失敗したら、自分の版も作らずに止める。
    const bundled = readInstalledMembers(root, commit, declaration, files);
    const embedState = { blobs: {}, versions: new Map(Object.entries(bundled)), snapshot: files, forks: new Set() };
    if (declaration.composition) {
        const spec = readLibrariesSpec(options.libraries);
        for (const member of declaration.composition) {
            if (embedState.versions.has(member.ref)) continue;
            await embedMember(root, member.ref, member.version, null, spec, embedState);
        }
    }
    for (const [rel, content] of Object.entries(embedState.blobs)) {
        files[rel] = sha256Hex(content);
    }
    const libraries = {};

    const ownPackageId = packageIdOf(files);
    const id = versionIdOf(files, libraries);

    console.log(`対象コミット: ${commit}`);
    console.log(`パッケージ: ${declaration.name} / ファイル: ${Object.keys(files).length} 点`);
    for (const [ref, version] of Object.entries(bundled)) {
        console.log(`導入済みの構成員: ${ref} = ${version}`);
    }
    for (const [ref, version] of embedState.versions) {
        if (ref in bundled) continue;
        console.log(
            embedState.forks.has(ref)
                ? `フォークの構成員: ${ref} = ${version}`
                : `取り寄せた構成員: ${ref} = ${version}`,
        );
    }
    console.log(`版ID: ${id}`);

    if (!options.skipForks && embedState.forks.size > 0) {
        await publishChangedForks(root, embedState, options);
    }

    const tagRef = tagRefFor(id, testLabel);
    if (testLabel) console.log(`種別: 開発中の版 TestVersion。ラベル: ${testLabel}`);

    fetchBranch(root, remote, VERSIONS_BRANCH);
    fetchIndex(root, remote);

    const { entries: indexEntries } = readIndexAt(root, `refs/heads/${INDEX_BRANCH}`);
    // リモートに nap/versions が無い移行後のリポジトリでは、索引の
    // 最後の版コミットからローカルの系譜を引き継ぐ。
    if (!refExists(root, `refs/heads/${VERSIONS_BRANCH}`) && indexEntries.length > 0) {
        git(
            ['update-ref', `refs/heads/${VERSIONS_BRANCH}`, indexEntries[indexEntries.length - 1].commit],
            { cwd: root },
        );
    }

    // 版コードは版IDから決める。
    const versionCode = deriveVersionCode(
        id,
        new Set(indexEntries.map((entry) => entry.code).filter(Boolean)),
    );

    const existing = remoteTagTarget(root, remote, tagRef);
    if (existing) {
        if (!options.noPush) pushSourceBranch(root, remote, options.ref, commit);
        // タグは既にある＝版は作らない。索引にだけ欠けがあれば補う。
        const added = appendIndex(
            root,
            remote,
            { id, commit: existing, at: new Date().toISOString(), tag: testLabel, source: commit, code: versionCode },
            chunkSize,
            !options.noPush,
        );
        if (added) console.log(`版コード: ${versionCode}`);
        console.log(
            added
                ? 'この版は登録されていました。一覧に載っていなかったため、登録を補いました'
                : 'この内容の版は既に公開されています。新しい版は作られません',
        );
        return { id, packageId: ownPackageId, tag: testLabel, noop: true };
    }

    // 専用コミット：パッケージのファイル＋マニフェスト。作業ツリーは触らない。
    const manifest = manifestBuffer(files, libraries);
    const entries = Object.entries(objects).map(([rel, o]) => ({ rel, oid: o.oid, mode: o.mode }));
    const tree = buildTree(root, null, entries, { [MANIFEST_NAME]: manifest, ...embedState.blobs });
    const versionsRef = `refs/heads/${VERSIONS_BRANCH}`;
    const versionsTip = refExists(root, versionsRef)
        ? gitText(['rev-parse', versionsRef], { cwd: root })
        : null;
    const labelSuffix = testLabel ? `-${testLabel}` : '';
    const description = typeof options.message === 'string' ? options.message.trim() : '';
    const versionMessage = `version ${id.slice(0, 12)}${labelSuffix}\n${description ? `\n${description}\n` : ''}`;
    const versionCommit = commitTree(root, tree, versionsTip ? [versionsTip] : [], versionMessage);
    git(['update-ref', versionsRef, versionCommit], { cwd: root });
    git(['update-ref', `refs/tags/${tagRef}`, versionCommit], { cwd: root });
    if (!options.noPush) {
        pushSourceBranch(root, remote, options.ref, commit);
        git(
            [
                'push',
                '--quiet',
                remote,
                `refs/tags/${tagRef}:refs/tags/${tagRef}`,
            ],
            { cwd: root },
        );
    }

    appendIndex(
        root,
        remote,
        { id, commit: versionCommit, at: new Date().toISOString(), tag: testLabel, source: commit, code: versionCode },
        chunkSize,
        !options.noPush,
    );

    console.log(`版コード: ${versionCode}`);
    console.log(`タグ: ${tagRef}`);
    console.log(
        options.noPush
            ? `タグ ${tagRef} を作りました。--no-push のため push はしていません`
            : `タグ ${tagRef} を ${remote} へ push しました`,
    );
    return { id, packageId: ownPackageId, tag: testLabel, noop: false };
}

module.exports = { publish, resolveRepoRoot, askYesNo };
