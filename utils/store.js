/**
 * store.js — 数据存储层（Cloudflare D1，经 tools-api Worker）
 *
 * 页面只需三件事：
 *   await Store.init();
 *   const { content } = await Store.getFile('data/types.json');     // content 为解析后的 JSON
 *   await Store.updateFile('data/types.json', list => { ...; return list; });
 *
 * 路径语义（页面用 Store.CONFIG.DATA_DIR 拼路径）：
 *   data/types.json       → marker_types 表（数组）
 *   data/{typeId}.geojson → marker_points 表（FeatureCollection）
 *   data/feedback.json    → feedback 表（数组）
 *   data/secrets.json     → vault 表（一行一条密文）
 *
 * 写入采用「内容比对 → 增量提交」：updateFile 先读服务端最新内容，跑页面给的
 * mutate，再把新旧内容的差异转成 POST / PATCH / DELETE 调用，最后回读一次
 * 把服务端真实结果（含新建记录的 id）返回给页面。这样页面里原有的
 * 「局部改一个点」逻辑不需要知道后端是表结构。
 *
 * 新增记录时页面**不要自己造 id**：POST 不带 id，由服务端发号，
 * 页面从 updateFile 返回的 content 里取回真实 id。
 */
window.Store = (function () {
    'use strict';

    const SELF_SRC = (document.currentScript && document.currentScript.src) || '';

    const CONFIG = {
        DATA_DIR: 'data',
        TYPES_FILE: 'data/types.json',
        FEEDBACK_FILE: 'data/feedback.json',
        SECRETS_FILE: 'data/secrets.json'
    };

    /* ==================== 依赖：api.js ==================== */

    let apiPromise = null;

    function loadApi() {
        if (window.CFApi) return Promise.resolve(window.CFApi);
        if (!apiPromise) {
            apiPromise = new Promise((resolve, reject) => {
                const src = SELF_SRC ? new URL('api.js', SELF_SRC).href : 'utils/api.js';
                const s = document.createElement('script');
                s.src = src;
                s.onload = () => (window.CFApi
                    ? resolve(window.CFApi)
                    : reject(new Error('api.js 已加载但 CFApi 未定义')));
                s.onerror = () => reject(new Error('api.js 加载失败: ' + src));
                document.head.appendChild(s);
            });
        }
        return apiPromise;
    }

    async function api() {
        await loadApi();
        if (!window.CFApi) throw new Error('CFApi 未就绪');
        return window.CFApi;
    }

    /* ==================== 路径解析 ==================== */

    function resolvePath(path) {
        if (path === CONFIG.TYPES_FILE) return { kind: 'types' };
        if (path === CONFIG.FEEDBACK_FILE) return { kind: 'feedback' };
        if (path === CONFIG.SECRETS_FILE) return { kind: 'vault' };

        const prefix = CONFIG.DATA_DIR + '/';
        const suffix = '.geojson';
        if (path.indexOf(prefix) === 0 && path.slice(-suffix.length) === suffix) {
            return { kind: 'points', typeId: path.slice(prefix.length, -suffix.length) };
        }
        throw new Error('未知的数据路径: ' + path);
    }

    /* ==================== 读 ==================== */

    async function read(path) {
        const k = resolvePath(path);
        const A = await api();

        if (k.kind === 'types') {
            const r = await A.markerTypes();
            const list = Array.isArray(r) ? r : ((r && r.types) || []);
            /* D1 列名是 created：统一回 created_at 给页面 */
            return list.map(t => ({
                id: t.id,
                name: t.name || '',
                color: t.color || '',
                created_at: t.created_at || t.created || 0
            }));
        }

        if (k.kind === 'points') {
            const fc = await A.markerPoints(k.typeId);
            return (fc && Array.isArray(fc.features)) ? fc : { type: 'FeatureCollection', features: [] };
        }

        if (k.kind === 'feedback') {
            const r = await A.feedbackList();
            return Array.isArray(r) ? r : ((r && r.feedback) || []);
        }

        /* vault：行级存储，一条密文一行，这里拼成页面需要的数组 */
        const r = await A.vaultItems();
        const list = Array.isArray(r) ? r : ((r && r.items) || []);
        return list.map(x => ({
            id: x.id,
            title: x.title || '',
            ciphertext: x.ciphertext || '',
            createdAt: Number(x.createdAt || x.created_at || 0),
            updatedAt: Number(x.updatedAt || x.updated_at || 0)
        }));
    }

    /* ==================== 写：差异比对 ==================== */

    const clone = v => (v === null || v === undefined) ? v : JSON.parse(JSON.stringify(v));

    const coordOf = f => (f && f.geometry && f.geometry.coordinates) || [];

    /* 内容指纹：用来认出「同一个点」（新建的 feature 没有 id） */
    function featureKey(f) {
        const c = coordOf(f);
        const p = (f && f.properties) || {};
        const lng = isFinite(Number(c[0])) ? Number(c[0]).toFixed(6) : '';
        const lat = isFinite(Number(c[1])) ? Number(c[1]).toFixed(6) : '';
        return [lng, lat, p.title || '', p.created_at || p.created || ''].join('|');
    }

    function sameFeature(a, b) {
        const ca = coordOf(a), cb = coordOf(b);
        if (Number(ca[0]) !== Number(cb[0]) || Number(ca[1]) !== Number(cb[1])) return false;
        return JSON.stringify(a.properties || {}) === JSON.stringify(b.properties || {});
    }

    async function commitTypes(cur, next) {
        const A = await api();
        cur = Array.isArray(cur) ? cur : [];
        next = Array.isArray(next) ? next : [];
        const curMap = new Map(cur.filter(t => t && t.id).map(t => [t.id, t]));
        const nextIds = new Set();

        for (const t of next) {
            /* 没有 id（或 id 不在库里）＝ 页面新建的：交给服务端发号 */
            const old = t.id ? curMap.get(t.id) : null;
            if (!old) {
                await A.addMarkerType({ name: t.name || '', color: t.color || '' });
                continue;
            }
            nextIds.add(t.id);
            if (old.name !== t.name || (old.color || '') !== (t.color || '')) {
                await A.updateMarkerType(t.id, { name: t.name || '', color: t.color || '' });
            }
        }
        for (const t of curMap.values()) {
            if (!nextIds.has(t.id)) await A.deleteMarkerType(t.id);
        }
    }

    async function commitPoints(typeId, cur, next) {
        const A = await api();
        const curFeats = (cur && cur.features) || [];
        const nextFeats = (next && next.features) || [];

        const byId = new Map(curFeats.filter(f => f.id).map(f => [f.id, f]));
        const used = new Set();
        const toAdd = [];
        const toPatch = [];

        for (const f of nextFeats) {
            let hit = f.id ? byId.get(f.id) : null;
            if (hit) {
                used.add(hit.id);
            } else {
                /* 页面新建的 feature 没有 id：按内容找已有的同一条，避免重复插入 */
                const key = featureKey(f);
                hit = curFeats.find(cf => cf.id && !used.has(cf.id) && featureKey(cf) === key) || null;
                if (hit) used.add(hit.id);
            }
            if (!hit) {
                toAdd.push(f);
            } else if (!sameFeature(hit, f)) {
                const p = f.properties || {};
                toPatch.push({
                    id: hit.id,
                    coordinates: coordOf(f),
                    title: p.title || '',
                    description: p.description || ''
                });
            }
        }

        if (toAdd.length) {
            /* 不传 id：由服务端生成（跨类型「移动标点」时若带上旧 id，
               紧接着删除旧类型会把刚插入的行一起删掉）。 */
            await A.addMarkerPoints({
                typeId,
                features: toAdd.map(f => ({
                    geometry: f.geometry,
                    title: (f.properties && f.properties.title) || '',
                    description: (f.properties && f.properties.description) || ''
                }))
            });
        }

        for (const p of toPatch) {
            await A.updateMarkerPoint(p.id, {
                coordinates: p.coordinates, title: p.title, description: p.description
            });
        }

        const removed = curFeats.filter(cf => cf.id && !used.has(cf.id));
        for (const cf of removed) await A.deleteMarkerPoint(cf.id);
    }

    async function commitFeedback(cur, next) {
        const A = await api();
        cur = Array.isArray(cur) ? cur : [];
        next = Array.isArray(next) ? next : [];
        const curIds = new Set(cur.map(f => f.id));
        const nextIds = new Set(next.map(f => f.id));

        for (const f of next) {
            if (curIds.has(f.id)) continue;
            if (!f.content || !String(f.content).trim()) continue;
            await A.addFeedback({
                type: f.type || '问题',
                content: f.content,
                contact: f.contact || '',
                source: f.source || ''
            });
        }
        const removed = [...curIds].filter(id => !nextIds.has(id));
        if (removed.length) await A.deleteFeedback(removed);
    }

    /**
     * vault 行级增量写入：新增 POST、改内容 PATCH、消失的 DELETE。
     * 单条存储后不同条目的操作互不影响；同一条并发编辑靠 baseUpdatedAt 条件更新，
     * 服务端发现版本不一致会返回 409，store 层面表现为抛出「已在其他设备上被修改」。
     */
    async function commitVault(cur, next) {
        const A = await api();
        cur = Array.isArray(cur) ? cur : [];
        next = Array.isArray(next) ? next : [];
        const curMap = new Map(cur.filter(x => x && x.id).map(x => [x.id, x]));
        const nextIds = new Set(next.filter(x => x && x.id).map(x => x.id));

        for (const item of next) {
            if (!item) continue;
            const old = item.id ? curMap.get(item.id) : null;
            if (!old) {
                /* 新建：不带 id，由服务端生成（真实 id 由 updateFile 回读带回页面） */
                await A.addVaultItem({
                    title: item.title || '',
                    ciphertext: item.ciphertext || '',
                    createdAt: item.createdAt || item.created_at || Date.now()
                });
            } else if ((old.title || '') !== (item.title || '') ||
                       (old.ciphertext || '') !== (item.ciphertext || '')) {
                /* 基准必须是「页面看到的那份」的版本（item.updatedAt），
                   不能用 old.updatedAt —— old 是刚刚重新读到的，永远是最新版本，
                   拿它当基准等于没有并发保护。 */
                await A.updateVaultItem(item.id, {
                    title: item.title || '',
                    ciphertext: item.ciphertext || ''
                }, item.updatedAt);
            }
        }

        const removed = [...curMap.keys()].filter(id => !nextIds.has(id));
        for (const id of removed) {
            try {
                await A.deleteVaultItem(id);
            } catch (e) {
                /* 已被其他设备删掉：目标状态已达成，不视为失败 */
                if (!/404|不存在/.test(e && e.message || '')) throw e;
            }
        }
    }

    async function commit(path, cur, next) {
        const k = resolvePath(path);
        if (k.kind === 'types') return commitTypes(cur, next);
        if (k.kind === 'points') return commitPoints(k.typeId, cur, next);
        if (k.kind === 'feedback') return commitFeedback(cur, next);
        return commitVault(cur, next);
    }

    /* ==================== 对外接口 ==================== */

    async function init() {
        await loadApi();
        return true;
    }

    async function getFile(path) {
        return { content: await read(path) };
    }

    async function updateFile(path, mutate) {
        const cur = await read(path);
        /* 页面的 mutate 多为原地修改（c.features.push / data.splice）：
           直接传 cur 会把"旧内容"一起改掉，导致差异比对永远为空（新增和删除都失效）。
           这里传副本，cur 保持原样用于比对。 */
        const next = await mutate(clone(cur));
        if (next === null || next === undefined) {
            return { content: cur, skipped: true };
        }
        await commit(path, cur, next);
        /* 回读：新建记录的服务端 id、被服务端裁剪的字段都以实际库为准 */
        return { content: await read(path), skipped: false };
    }

    async function deleteFile(path) {
        const k = resolvePath(path);
        const A = await api();

        if (k.kind === 'points') {
            const fc = await read(path);
            const feats = (fc && fc.features) || [];
            for (const f of feats) if (f.id) await A.deleteMarkerPoint(f.id);
            return feats.length > 0;
        }
        if (k.kind === 'types') {
            const list = await read(path);
            for (const t of list) await A.deleteMarkerType(t.id);
            return list.length > 0;
        }
        return false;
    }

    /* 反馈是公开提交，不需要先读全量列表 */
    async function appendFeedback(item) {
        const A = await api();
        return A.addFeedback({
            type: item.type || '问题',
            content: item.content,
            contact: item.contact || '',
            source: item.source || ''
        });
    }

    return { CONFIG, init, getFile, updateFile, deleteFile, appendFeedback };
})();
