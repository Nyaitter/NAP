'use strict';

// GitHub のコード検索で nap.json を持つリポジトリを探し、
// 各リポジトリの nap.json を読んでパッケージ名と構成を表示する。
// コード検索には認証が必要なため、トークンを GITHUB_TOKEN から読む。
// 無ければ GH_TOKEN を読む。

function buildQuery(keywords) {
    return ['filename:nap.json', ...keywords].join(' ');
}

// 検索結果の項目から、リポジトリ単位に重複を取り除く。
function dedupeRepos(items) {
    const seen = new Map();
    for (const item of items || []) {
        const repo = item && item.repository && item.repository.full_name;
        if (!repo || seen.has(repo)) continue;
        seen.set(repo, {
            repo,
            defaultBranch: item.repository.default_branch || 'HEAD',
            htmlUrl: item.repository.html_url || '',
        });
    }
    return [...seen.values()];
}

async function fetchJson(url, token, fetchImpl) {
    const res = await fetchImpl(url, {
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
        },
    });
    if (!res.ok) {
        let detail = '';
        try {
            const body = await res.json();
            detail = body && body.message ? `: ${body.message}` : '';
        } catch {
            detail = '';
        }
        throw new Error(`GitHub API がエラーを返しました。HTTP ${res.status}${detail}`);
    }
    return res.json();
}

async function search(keywords, options = {}) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
    if (!token) {
        throw new Error(
            'GitHub のコード検索には認証が必要です。GITHUB_TOKEN にトークンを設定してください。',
        );
    }
    const fetchImpl = options.fetch || ((...args) => globalThis.fetch(...args));
    const apiBase = (process.env.NAP_GITHUB_API_BASE || 'https://api.github.com').replace(/\/$/, '');
    const rawBase = (process.env.NAP_RAW_BASE || 'https://raw.githubusercontent.com').replace(/\/$/, '');
    const limit = options.limit || 20;

    const query = buildQuery(keywords);
    const url = `${apiBase}/search/code?q=${encodeURIComponent(query)}&per_page=100`;
    const data = await fetchJson(url, token, fetchImpl);
    const candidates = dedupeRepos(data.items).slice(0, limit);
    if (candidates.length === 0) {
        console.log('パッケージは見つかりませんでした。');
        return;
    }
    console.log(`候補: ${data.total_count} 件中 ${candidates.length} 件のリポジトリを確認します`);
    for (const candidate of candidates) {
        let summary = 'nap.json を読めませんでした';
        try {
            const res = await fetchImpl(
                `${rawBase}/${candidate.repo}/${candidate.defaultBranch}/nap.json`,
            );
            if (res.ok) {
                const declaration = await res.json();
                const members = Array.isArray(declaration.composition)
                    ? declaration.composition.length
                    : 0;
                summary = `パッケージ: ${declaration.name || '名前なし'} / 構成員: ${members} 件`;
            }
        } catch {
            summary = 'nap.json を読めませんでした';
        }
        console.log(`  ${candidate.repo}  ${summary}`);
    }
    if (data.total_count > candidates.length) {
        console.log(`他 ${data.total_count - candidates.length} 件。キーワードで絞り込めます`);
    }
}

module.exports = { search, buildQuery, dedupeRepos };
