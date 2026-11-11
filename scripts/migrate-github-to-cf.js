#!/usr/bin/env node
/**
 * migrate-github-to-cf.js — 把 GitHub 数据分支的存量数据一次性导入 Cloudflare D1
 *
 * 前置：
 *   1. wrangler d1 建库并执行 schema.sql
 *   2. Worker 已部署，ADMIN_TOKEN 已通过 `wrangler secret put ADMIN_TOKEN` 配置
 *   3. 一个有 tools 仓库读取权限的 GitHub Token（classic 的 repo 权限即可，只读拉取）
 *
 * 用法（bash）：
 *   GH_TOKEN=ghp_xxx \
 *   CF_BASE=https://ulnae.localhost.cc \
 *   ADMIN_TOKEN=<与 Worker secret 相同> \
 *   node scripts/migrate-github-to-cf.js
 *
 * 幂等：worker 端全部 INSERT OR IGNORE / OR REPLACE，可重复执行。
 * 同一指纹的老用户若在 D1 里已存在（切换后新产生的记录），会按 fp 归并到
 * 同一条记录，并把 visits 改挂到现存 id，同时保留更早的 created。
 */

const crypto = require('crypto');

const OWNER = 'ulnae';
const REPO = 'tools';
const BRANCH = { stats: 'stats', marker: 'marker', feedback: 'feedback', vault: 'vault' };

/* 存量 geojson 的 feature 没有 id（标识只在 properties 里），而 marker_points
   以 id 为主键。这里用「类型 + 坐标 + 标题 + 创建时间」生成确定性 id：
   同一份数据每次跑都得到同样的 id，保证迁移幂等且不会互相覆盖。 */
function pointId(typeId, f) {
    const c = (f.geometry && f.geometry.coordinates) || [];
    const p = f.properties || {};
    return crypto.createHash('sha1')
        .update([typeId, c[0], c[1], p.title || '', p.created_at || ''].join('|'))
        .digest('hex').slice(0, 16);
}

const GH_HEADERS = {
    Authorization: `Bearer ${process.env.GH_TOKEN || ''}`,
    Accept: 'application/vnd.github+json'
};

if (!process.env.GH_TOKEN || !process.env.CF_BASE || !process.env.ADMIN_TOKEN) {
    console.error('缺少环境变量：GH_TOKEN / CF_BASE / ADMIN_TOKEN');
    process.exit(1);
}

/* ---------- GitHub 读取 ---------- */

async function ghJson(path, branch) {
    const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=${branch}`;
    const res = await fetch(url, { headers: GH_HEADERS });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${path}`);
    const data = await res.json();
    const text = Buffer.from((data.content || '').replace(/\s/g, ''), 'base64').toString('utf8');
    return text ? JSON.parse(text) : null;
}

/* ---------- 拉取并归一 ---------- */

async function collectStats() {
    const idx = (await ghJson('data/users.json', BRANCH.stats)) || {};
    const users = Array.isArray(idx.users) ? idx.users : [];
    const visits = [];
    for (const u of users) {
        try {
            const f = await ghJson(`data/visits/${u.id}.json`, BRANCH.stats);
            if (f && Array.isArray(f.visits)) {
                f.visits.forEach(v => visits.push(Object.assign({}, v, { user_id: u.id })));
            }
        } catch (e) {
            console.warn(`跳过 ${u.id}: ${e.message}`);
        }
    }
    return { users, visits };
}

async function collectMarker() {
    const rawTypes = (await ghJson('data/types.json', BRANCH.marker)) || [];
    /* 存量用 created_at / updated_at，D1 用 created：这里归一，避免全落成导入时间 */
    const types = rawTypes.map(t => Object.assign({}, t, {
        created: t.created_at || t.created,
        updated: t.updated_at || t.updated
    }));
    const points = [];
    for (const t of types) {
        try {
            const fc = await ghJson(`data/${t.id}.geojson`, BRANCH.marker);
            const feats = (fc && Array.isArray(fc.features)) ? fc.features : [];
            feats.forEach(f => points.push({
                id: f.id || (f.properties && f.properties.id) || pointId(t.id, f),
                type_id: t.id,
                lng: f.geometry && f.geometry.coordinates ? f.geometry.coordinates[0] : null,
                lat: f.geometry && f.geometry.coordinates ? f.geometry.coordinates[1] : null,
                props: Object.assign({}, f.properties, { type: t.id })
            }));
        } catch (e) {
            console.warn(`跳过类型 ${t.id}: ${e.message}`);
        }
    }
    return { markerTypes: types, markerPoints: points.filter(p => isFinite(p.lng) && isFinite(p.lat)) };
}

/* ---------- 密文笔记（整包，单行 blob） ---------- */

async function migrateVault() {
    const raw = await ghJson('data/secrets.json', BRANCH.vault);
    const items = Array.isArray(raw) ? raw : ((raw && raw.items) || []);
    if (!items.length) { console.log('vault: GitHub 上无数据，跳过'); return; }

    const base = process.env.CF_BASE.replace(/\/+$/, '');
    const cur = await fetch(`${base}/api/vault`).then(r => r.json()).catch(() => ({}));
    const blob = (cur && typeof cur.blob === 'string') ? cur.blob.trim() : '';
    const hasData = blob && blob !== '[]';
    if (hasData && !process.env.FORCE_VAULT) {
        console.log(`vault: D1 已有数据（${blob.length} 字节），跳过以免覆盖；如需强制覆盖请设 FORCE_VAULT=1`);
        return;
    }

    const res = await fetch(`${base}/api/vault`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blob: JSON.stringify(items) })
    });
    if (!res.ok) throw new Error(`vault 写入失败: ${res.status}`);
    console.log(`vault: 已导入 ${items.length} 条`);
}

/* ---------- 导入 ---------- */

(async () => {
    console.log('拉取 GitHub 存量数据...');
    const stats = await collectStats();
    const marker = await collectMarker();
    const feedback = (await ghJson('data/feedback.json', BRANCH.feedback)) || [];

    const payload = {
        users: stats.users,
        visits: stats.visits,
        markerTypes: marker.markerTypes,
        markerPoints: marker.markerPoints,
        feedback: Array.isArray(feedback) ? feedback : (feedback.feedback || [])
    };
    console.log(`users=${payload.users.length} visits=${payload.visits.length} ` +
        `types=${payload.markerTypes.length} points=${payload.markerPoints.length} feedback=${payload.feedback.length}`);

    console.log('导入 D1...');
    const res = await fetch(`${process.env.CF_BASE.replace(/\/+$/, '')}/api/admin/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
        body: JSON.stringify(payload)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        console.error('导入失败:', res.status, body);
        process.exit(1);
    }
    console.log('导入完成:', JSON.stringify(body.imported));

    /* vault 走公开端点（整包覆盖写），与其他模块分开处理，且默认不覆盖已有数据 */
    await migrateVault();

    console.log('验证：curl "' + process.env.CF_BASE + '/api/admin/stats" -H "Authorization: Bearer $ADMIN_TOKEN"');
})();
