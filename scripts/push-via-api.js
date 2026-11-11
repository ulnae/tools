#!/usr/bin/env node
/**
 * push-via-api.js — 代理不可用时的推送兜底：用 GitHub Git Data API 提交本地 HEAD
 *
 * 适用场景：能访问 api.github.com，但到 github.com:443 的通道被阻断（git push 失败）。
 *
 * 做法：把「本地 HEAD 相对远端 master 新增/修改的文件」以 blob 形式上传，
 * 用本地提交的 tree / author / committer / message 重建一个 commit。
 * 只要内容一致，GitHub 算出的 commit sha 与本地完全相同，不会产生分叉。
 *
 * 用法：
 *   GH_TOKEN=github_pat_xxx node scripts/push-via-api.js
 */
const { execSync } = require('child_process');

const TOKEN = process.env.GH_TOKEN;
const OWNER = 'ulnae', REPO = 'tools', BRANCH = 'master';
if (!TOKEN) { console.error('缺少 GH_TOKEN'); process.exit(1); }

const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const sh = cmd => execSync(cmd, { encoding: 'utf8' });

async function api(path, opts = {}) {
    const res = await fetch(API + path, {
        method: opts.method || 'GET',
        headers: {
            Authorization: `Bearer ${TOKEN}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'push-via-api'
        },
        body: opts.body ? JSON.stringify(opts.body) : (opts.raw || undefined)
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

(async () => {
    /* 1. 本地提交信息 */
    const raw = sh('git cat-file -p HEAD');
    const lines = raw.split('\n');
    const tree = /^tree (\w+)/.exec(lines[0])[1];
    const parent = (/^parent (\w+)/.exec(lines[1]) || [])[1];
    /* base_tree 必须是父提交的树，不是本次提交的树 */
    const baseTree = /^tree (\w+)/.exec(sh(`git cat-file -p ${parent}`).split('\n')[0])[1];
    const authorLine = lines.find(l => l.startsWith('author '));
    const committerLine = lines.find(l => l.startsWith('committer '));
    const bodyStart = raw.indexOf('\n\n') + 2;
    const fullMessage = raw.slice(bodyStart);          /* 含结尾换行 */
    const messageTrimmed = fullMessage.replace(/\n$/, '');

    const parse = line => {
        const m = /^(?:author|committer) (.+) <(.+)> (\d+) ([+-]\d{4})$/.exec(line);
        return { name: m[1], email: m[2], ts: Number(m[3]), tz: m[4] };
    };
    const author = parse(authorLine), committer = parse(committerLine);

    console.log('本地 HEAD tree:', tree);
    console.log('本地 parent  :', parent);

    /* 2. 远端当前 head 应与本地 parent 一致 */
    const ref = await api(`/git/ref/heads/${BRANCH}`);
    const remoteHead = ref.object.sha;
    if (remoteHead !== parent) {
        throw new Error(`远端 head ${remoteHead} 与本地 parent ${parent} 不一致，请先同步再试`);
    }

    /* 3. 本次改动文件（相对 parent） */
    const status = sh(`git diff --name-status ${parent} HEAD`).trim();
    const changes = status ? status.split('\n').map(l => {
        const [st, ...p] = l.split('\t');
        return { status: st[0], path: p.join('\t') };
    }) : [];
    const deleted = changes.filter(c => c.status === 'D');
    if (deleted.length) {
        throw new Error('本脚本不支持含删除的提交，请走正常 push：' + deleted.map(d => d.path).join(', '));
    }
    console.log('待提交文件:', changes.map(c => c.path).join(', '));

    /* 4. 比对 blob sha，确认磁盘内容与 git 对象一致后再上传 */
    const treeEntries = [];
    for (const c of changes) {
        const localSha = sh(`git hash-object "${c.path}"`).trim();
        const lsTree = sh(`git ls-tree HEAD -- "${c.path}"`).trim();
        const headSha = (/^\d+ blob (\w+)/.exec(lsTree) || [])[1];
        if (headSha !== localSha) throw new Error(`文件 ${c.path} 与 HEAD 内容不一致（可能是换行符），请先 git add`);

        const content = require('fs').readFileSync(c.path);
        const blob = await api('/git/blobs', {
            method: 'POST',
            body: { content: content.toString('base64'), encoding: 'base64' }
        });
        if (blob.sha !== localSha) throw new Error(`blob sha 不匹配：${c.path} ${blob.sha} != ${localSha}`);
        treeEntries.push({ path: c.path, mode: '100644', type: 'blob', sha: blob.sha });
    }

    /* 5. 建树 */
    const treeRes = await api('/git/trees', { method: 'POST', body: { base_tree: baseTree, tree: treeEntries } });
    if (treeRes.sha !== tree) throw new Error(`tree sha 不匹配：${treeRes.sha} != ${tree}`);
    console.log('远端 tree 重建一致:', treeRes.sha);

    /* 6. 建提交：消息结尾换行有无各试一次，命中本地 sha 为止 */
    const candidates = [messageTrimmed, fullMessage];
    let created = null;
    for (const msg of candidates) {
        const commit = await api('/git/commits', {
            method: 'POST',
            body: {
                message: msg,
                tree: treeRes.sha,
                parents: [parent],
                author: { name: author.name, email: author.email, date: isoWithOffset(author.ts, author.tz) },
                committer: { name: committer.name, email: committer.email, date: isoWithOffset(committer.ts, committer.tz) }
            }
        });
        if (commit.sha === sh('git rev-parse HEAD').trim()) { created = commit; break; }
        console.log('  sha 未命中:', commit.sha);
    }
    if (!created) throw new Error('生成的 commit sha 与本地不一致，已放弃更新引用');
    console.log('远端 commit 与本地一致:', created.sha);

    /* 7. 移动分支（快进，非强推） */
    await api(`/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: { sha: created.sha, force: false } });
    console.log('已更新远端 ' + BRANCH + ' →', created.sha);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
