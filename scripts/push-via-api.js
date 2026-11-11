#!/usr/bin/env node
/**
 * push-via-api.js — 代理不可用时的推送兜底：用 GitHub Git Data API 把本地提交逐个重放到远端
 *
 * 适用场景：能访问 api.github.com，但到 github.com:443 的通道被阻断（git push 失败）。
 *
 * 做法：从远端 head 开始，按拓扑顺序把 `远端head..HEAD` 的每个提交依次重建：
 * 上传改动 blob → 以父提交的树为 base_tree 建树 → 用原始的 author/committer/message 建提交。
 * 每一步都会校验 tree sha 与 commit sha 是否与本地一致，所以成功后历史与本地完全相同，
 * 不会分叉，也不是强推。
 *
 * 用法：
 *   GH_TOKEN=github_pat_xxx node scripts/push-via-api.js
 */
const { execFileSync } = require('child_process');

const TOKEN = process.env.GH_TOKEN;
const OWNER = 'ulnae', REPO = 'tools', BRANCH = 'master';
if (!TOKEN) { console.error('缺少 GH_TOKEN'); process.exit(1); }

const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

/* 参数数组调用，避免路径里的空格/中文被 shell 吃掉 */
function git(args, opts = {}) {
    return execFileSync('git', args, Object.assign({ maxBuffer: 512 * 1024 * 1024 }, opts));
}
const gitText = args => git(args, { encoding: 'utf8' }).trim();
const gitBuf = args => git(args, { encoding: 'buffer' });

async function api(path, opts = {}) {
    const res = await fetch(API + path, {
        method: opts.method || 'GET',
        headers: {
            Authorization: `Bearer ${TOKEN}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'push-via-api'
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
    if (!res.ok) throw new Error(`API ${res.status} ${path}: ${JSON.stringify(data).slice(0, 300)}`);
    return data;
}

/* 毫秒时间戳 + 时区偏移 → 2026-11-11T16:20:33+08:00 */
function isoWithOffset(ts, tz) {
    const sign = tz[0] === '-' ? -1 : 1;
    const hh = Number(tz.slice(1, 3)), mm = Number(tz.slice(3, 5));
    const shifted = new Date((ts + sign * (hh * 3600 + mm * 60)) * 1000);
    const p = n => String(n).padStart(2, '0');
    return `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}` +
        `T${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}${tz.slice(0, 3)}:${tz.slice(3, 5)}`;
}

/* 解析提交对象：tree / parents / author / committer / message */
function readCommit(sha) {
    const raw = gitBuf(['cat-file', 'commit', sha]).toString('utf8');
    const header = raw.slice(0, raw.indexOf('\n\n'));
    const message = raw.slice(raw.indexOf('\n\n') + 2);
    const lines = header.split('\n');
    const parse = line => {
        const m = /^(?:author|committer) (.+) <(.+)> (\d+) ([+-]\d{4})$/.exec(line);
        return { name: m[1], email: m[2], ts: Number(m[3]), tz: m[4] };
    };
    return {
        tree: /^tree (\w+)/.exec(lines[0])[1],
        parents: lines.filter(l => l.startsWith('parent ')).map(l => l.slice(7).trim()),
        author: parse(lines.find(l => l.startsWith('author '))),
        committer: parse(lines.find(l => l.startsWith('committer '))),
        message
    };
}

/* 提交间改动：A/M/D（重命名按删除+新增展开） */
function diffChanges(from, to) {
    const out = gitText(['diff', '--name-status', '--no-renames', '-z', from, to]);
    const parts = out.split('\0').filter(Boolean);
    const list = [];
    for (let i = 0; i < parts.length;) {
        const st = parts[i++], path = parts[i++];
        if (!path) break;
        list.push({ status: st[0], path });
    }
    return list;
}

const blobCache = new Map();
async function uploadBlob(commit, path) {
    const entry = gitText(['ls-tree', commit, '--', path]);          /* 100644 blob <sha>\t<path> */
    const m = /^(\d{6}) blob (\w+)\t/.exec(entry);
    if (!m) throw new Error(`取不到 ${path} 的 blob（子模块或非常规文件？）`);
    const [, mode, sha] = m;
    if (!blobCache.has(sha)) {
        const content = gitBuf(['cat-file', 'blob', sha]);
        const blob = await api('/git/blobs', {
            method: 'POST',
            body: { content: content.toString('base64'), encoding: 'base64' }
        });
        if (blob.sha !== sha) throw new Error(`blob sha 不匹配：${path} ${blob.sha} != ${sha}`);
        blobCache.set(sha, true);
    }
    return { path, mode, type: 'blob', sha };
}

(async () => {
    const ref = await api(`/git/ref/heads/${BRANCH}`);
    const remoteHead = ref.object.sha;
    const head = gitText(['rev-parse', 'HEAD']);
    console.log('远端 head:', remoteHead);
    console.log('本地 HEAD:', head);

    if (remoteHead === head) return console.log('已是最新，无需推送');

    try {
        git(['merge-base', '--is-ancestor', remoteHead, head]);
    } catch (_) {
        throw new Error(`远端 ${remoteHead} 不是本地 HEAD 的祖先，存在分叉，请先同步再试`);
    }

    const commits = gitText(['rev-list', '--reverse', `${remoteHead}..${head}`]).split('\n').filter(Boolean);
    console.log(`待推送 ${commits.length} 个提交`);

    let parent = remoteHead;
    for (const sha of commits) {
        const c = readCommit(sha);
        const subject = c.message.split('\n')[0];
        console.log(`\n→ ${sha.slice(0, 7)} ${subject}`);

        const changes = diffChanges(parent, sha);
        const entries = [];
        for (const ch of changes) {
            if (ch.status === 'D') {
                entries.push({ path: ch.path, mode: '100644', type: 'blob', sha: null });
            } else {
                entries.push(await uploadBlob(sha, ch.path));
            }
        }

        const baseTree = gitText(['rev-parse', `${parent}^{tree}`]);
        const tree = await api('/git/trees', { method: 'POST', body: { base_tree: baseTree, tree: entries } });
        if (tree.sha !== c.tree) throw new Error(`tree sha 不匹配：${tree.sha} != ${c.tree}（${subject}）`);

        const created = await api('/git/commits', {
            method: 'POST',
            body: {
                message: c.message,
                tree: tree.sha,
                parents: [parent],
                author: { name: c.author.name, email: c.author.email, date: isoWithOffset(c.author.ts, c.author.tz) },
                committer: { name: c.committer.name, email: c.committer.email, date: isoWithOffset(c.committer.ts, c.committer.tz) }
            }
        });
        if (created.sha !== sha) throw new Error(`commit sha 不一致：${created.sha} != ${sha}（${subject}）`);

        console.log(`   ✓ ${changes.length} 个文件，sha 与本地一致`);
        parent = sha;
    }

    await api(`/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: { sha: parent, force: false } });
    console.log(`\n已更新远端 ${BRANCH} → ${parent}`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
