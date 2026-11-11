/**
 * store.js — 数据存储层（Cloudflare D1，经 tools-api Worker）
 *
 * 与旧版 utils/github.js 保持**完全相同的调用契约**，页面只需把
 *   <script src=".../utils/github.js"></script>
 * 换成
 *   <script src=".../utils/store.js"></script>
 * 并把标识符 GitHub. 改为 Store.，业务逻辑一行不用动：
 *
 *   await Store.init();                                  // 等待依赖就绪
 *   const { content, sha } = await Store.getFile(path);  // content 为解析后的 JSON
 *   await Store.updateFile(path, mutate, msg, 4, branch);// mutate(latest) → 新对象 / null
 *   await Store.deleteFile(path, msg, branch);           // 返回布尔
 *
 * 路径语义沿用旧约定（页面里用 Store.CONFIG.DATA_DIR 拼路径）：
 *   data/types.json       → marker_types 表（数组）
 *   data/{typeId}.geojson → marker_points 表（FeatureCollection）
 *   data/feedback.json    → feedback 表（数组，需要 ADMIN_TOKEN）
 *   data/secrets.json     → vault 表（整包密文数组）
 *
 * 写入采用「内容比对 → 增量提交」：updateFile 先读服务端最新内容，跑页面给的
 * mutate，再把新旧内容的差异转成 POST / PATCH / DELETE 调用，最后回读一次
 * 把服务端真实结果（含新建记录的 id）返回给页面。这样页面里原有的
 * 「局部改一个点」逻辑不需要知道后端是表结构。
 */
window.Store = (function () {
    'use strict';

    const SELF_SRC = (document.currentScript && document.currentScript.src) || '';

    const CONFIG = {
        /* 仅保留页面会用到的路径常量，语义与 github.js 一致 */
        DATA_DIR: 'data',
        TYPES_FILE: 'data/types.json',
        FEEDBACK_FILE: 'data/feedback.json',
        SECRETS_FILE: 'data/secrets.json',
        MARKER_BRANCH: 'marker',
        VAULT_BRANCH: 'vault',
        FEEDBACK_BRANCH: 'feedback'
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
            /* 存量字段是 created_at，D1 是 created：统一回 created_at 给页面 */
            return list.map(t => ({
                id: t.id,
                name: t.name || '',
                color: t.color || '',
                sort: Number(t.sort || 0),
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

        /* vault：整包密文放在一行 blob 里，页面拿到的是数组 */
        const v = await A.getVault();
        const raw = (v && typeof v.blob === 'string') ? v.blob : '';
        if (!raw) return [];
        try { return JSON.parse(raw); } catch (_) { return []; }
    }

    /* ==================== 写：差异比对 ==================== */

    const clone = v => (v === null || v === undefined) ? v : JSON.parse(JSON.stringify(v));

    const coordOf = f => (f && f.geometry && f.geometry.coordinates) || [];

    /* 内容指纹：存量 geojson 没有 id，用「坐标 + 标题 + 创建时间」认出同一个点 */
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
        const curMap = new Map(cur.map(t => [t.id, t]));
        const nextMap = new Map(next.map(t => [t.id, t]));

        for (const t of next) {
            const old = curMap.get(t.id);
            if (!old) {
                await A.addMarkerType({
                    id: t.id, name: t.name || '', color: t.color || '', sort: Number(t.sort || 0)
                });
            } else if (old.name !== t.name || (old.color || '') !== (t.color || '') ||
                       Number(old.sort || 0) !== Number(t.sort || 0)) {
                await A.updateMarkerType(t.id, {
                    name: t.name || '', color: t.color || '', sort: Number(t.sort || 0)
                });
            }
        }
        for (const t of cur) {
            if (!nextMap.has(t.id)) await A.deleteMarkerType(t.id);
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
                toPatch.push({
                    id: hit.id,
                    coordinates: coordOf(f),
                    properties: Object.assign({}, f.properties, { type: typeId })
                });
            }
        }

        if (toAdd.length) {
            /* 不传 id：让服务端生成。跨类型「移动标点」时若带上旧 id，
               紧接着删除旧类型会把刚插入的行一起删掉。 */
            await A.addMarkerPoints({
                type: 'FeatureCollection',
                features: toAdd.map(f => ({
                    type: 'Feature',
                    geometry: f.geometry,
                    properties: Object.assign({}, f.properties, { type: typeId })
                }))
            });
        }

        for (const p of toPatch) {
            await A.updateMarkerPoint(p.id, { coordinates: p.coordinates, properties: p.properties });
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

    async function commit(path, cur, next) {
        const k = resolvePath(path);
        if (k.kind === 'types') return commitTypes(cur, next);
        if (k.kind === 'points') return commitPoints(k.typeId, cur, next);
        if (k.kind === 'feedback') return commitFeedback(cur, next);
        const A = await api();
        return A.putVault(JSON.stringify(next));
    }

    /* ==================== 对外接口（与 github.js 同形） ==================== */

    async function init() {
        await loadApi();
        return true;
    }

    async function getFile(path) {
        const content = await read(path);
        return { content, sha: 'cf' };
    }

    async function putFile(path, obj) {
        await commit(path, await read(path), obj);
        return { content: await read(path), sha: 'cf' };
    }

    async function updateFile(path, mutate, message, maxAttempts, branch) {
        const cur = await read(path);
        /* 页面的 mutate 多为原地修改（c.features.push / data.splice）：
           直接传 cur 会把"旧内容"一起改掉，导致差异比对永远为空（新增和删除都失效）。
           这里传副本，cur 保持原样用于比对。 */
        const next = await mutate(clone(cur), 'cf');
        if (next === null || next === undefined) {
            return { content: cur, sha: 'cf', skipped: true };
        }
        await commit(path, cur, next);
        /* 回读：新建记录的服务端 id、被服务端裁剪的字段都以实际库为准 */
        return { content: await read(path), sha: 'cf', skipped: false };
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

    /* 反馈是公开提交，不需要先读全量（列表接口要 ADMIN_TOKEN） */
    async function appendFeedback(item) {
        const A = await api();
        return A.addFeedback({
            type: item.type || '问题',
            content: item.content,
            contact: item.contact || '',
            source: item.source || ''
        });
    }

    return {
        CONFIG,
        init,
        loadApi,
        getFile,
        putFile,
        updateFile,
        deleteFile,
        appendFeedback,
        /* 便于调试：控制台 Store.read('data/xxx.geojson') */
        read
    };
})();
