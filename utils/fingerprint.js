/**
 * fingerprint.js — 浏览器指纹 + 云端访问统计（Cloudflare D1 存储）
 *
 * 存储链路：浏览器 → ulnae.localhost.cc（Netlify 反代）→ Cloudflare Worker → D1
 *   - 指纹计算逻辑与旧版完全一致（FingerprintJS v4.6.2），同一设备的 visitorId 不变，
 *     因此历史用户迁移后可继续命中同一条记录；
 *   - 旧版的 GitHub Contents API 写入（utils/github.js）已不再使用。
 *
 * 引入方式（绝对地址，任意目录层级通用）：
 *   <script src="https://ulnae.github.io/tools/utils/tracker-config.js"></script>
 *   <script src="https://ulnae.github.io/tools/utils/fp.min.js"></script>
 *   <script src="https://ulnae.github.io/tools/utils/fingerprint.js"></script>
 *
 * api.js 无需显式引入：本文件会在 ready 开始时自动加载它（已引入则直接复用）。
 *
 * 对外 API（window.VisitTracker）：
 *   await VisitTracker.ready                  // 初始化完成（含自动上报）
 *   await VisitTracker.track()                // 手动记录一次访问
 *   await VisitTracker.getUsers()             // 用户索引数组（含 visitCount）
 *   await VisitTracker.getUser(id)            // 单个用户完整数据 { ..., visits: [] }
 *   await VisitTracker.removeVisit(id, vid)   // 删除该用户的一条访问
 *   await VisitTracker.removeUser(id)         // 删除用户
 *   await VisitTracker.clearAll()             // 清空全部统计
 *
 * 管理端操作需 ADMIN_TOKEN：优先 VISIT_TRACKER_CONFIG.adminToken，
 * 其次 sessionStorage 的 cf_admin_token（由 manage/stats.html 引导输入）。
 */
(function () {
    'use strict';

    const CFG = {
        disableAutoTrack: false,
        maxVisits: 500,                   // 仅作展示上限参考，服务端按 500 返回
        debug: true,
        /* api.js 的地址：页面若已显式引入则不会用到；未引入时由此动态加载，
           使得只引 fingerprint.js 的页面零改动即可工作。 */
        apiScript: 'https://ulnae.github.io/tools/utils/api.js'
    };
    if (window.VISIT_TRACKER_CONFIG && typeof window.VISIT_TRACKER_CONFIG === 'object') {
        Object.assign(CFG, window.VISIT_TRACKER_CONFIG);
    }

    const LIB_READY_EVENT = 'fingerprintjs-ready';
    const TRACKED_EVENT = 'visit-tracked';
    const log = (...a) => { if (CFG.debug) console.log('[VisitTracker.CF]', ...a); };
    const warn = (...a) => console.warn('[VisitTracker.CF]', ...a);

    const api = () => {
        if (!window.CFApi) throw new Error('api.js 尚未加载完成，请 await VisitTracker.ready 后再调用');
        return window.CFApi;
    };

    /* 动态加载 api.js（页面未显式引入时的兜底）。 */
    let apiPromise = null;
    function loadApi() {
        if (window.CFApi) return Promise.resolve(window.CFApi);
        if (!apiPromise) {
            apiPromise = new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = CFG.apiScript;
                s.onload = () => (window.CFApi
                    ? resolve(window.CFApi)
                    : reject(new Error('api.js 已加载但 CFApi 未定义')));
                s.onerror = () => reject(new Error('api.js 加载失败: ' + CFG.apiScript));
                document.head.appendChild(s);
            });
        }
        return apiPromise;
    }

    /* ==================== 小工具 ==================== */
    const pad = n => String(n).padStart(2, '0');
    const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    const newId = () => {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
            const b = crypto.getRandomValues(new Uint8Array(16));
            b[6] = (b[6] & 0x0f) | 0x40;
            b[8] = (b[8] & 0x3f) | 0x80;
            const hex = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
            return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        }
        return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    };
    const newVisitId = newId;

    /* ==================== 1. 指纹（与原版一致） ==================== */
    async function getBrowserFingerprint() {
        if (typeof window.FingerprintJS === 'undefined') {
            throw new Error('FingerprintJS 未加载，请先引入 utils/fp.min.js');
        }
        const fp = await window.FingerprintJS.load({ monitor: false });
        return fp.get();
    }
    window.getBrowserFingerprint = getBrowserFingerprint;

    let fpPromise = null;
    function fpCached() {
        if (!fpPromise) {
            fpPromise = getBrowserFingerprint().catch(err => {
                fpPromise = null;
                throw err;
            });
        }
        return fpPromise;
    }

    /* ==================== 2. 访问数据组装（与原版一致） ==================== */
    function envInfo() {
        const nav = window.navigator || {};
        const s = window.screen || {};
        return {
            ua: nav.userAgent || '',
            screen: `${s.width || 0}x${s.height || 0}`,
            dpr: window.devicePixelRatio || 1,
            lang: nav.language || '',
            tz: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return ''; } })()
        };
    }

    function buildVisit(extra = {}) {
        const loc = window.location;
        return Object.assign({
            id: newVisitId(),
            ts: Date.now(),
            day: dayKey(),
            page: (loc.pathname.split('/').pop() || 'index.html'),
            path: loc.pathname,
            title: document.title || '',
            ref: (() => { try { return document.referrer ? new URL(document.referrer).host : ''; } catch (_) { return ''; } })()
        }, extra);
    }

    /* ==================== 3. 用户索引缓存（管理端读取用） ==================== */
    let userIndexCache = null;   /* { at, data } */
    const INDEX_TTL = 30000;

    function invalidateIndex() { userIndexCache = null; }

    async function fetchUserIndex(limit = 500) {
        if (userIndexCache && Date.now() - userIndexCache.at < INDEX_TTL) return userIndexCache.data;
        const data = await api().users(limit);
        userIndexCache = { at: Date.now(), data: data.users || [] };
        return userIndexCache.data;
    }

    /* ==================== 4. 对外 API（形状与原版一致） ==================== */
    const VisitTracker = {
        /* 数据只存云端 D1 */
        get mode() { return 'cloud-cf'; },

        async track(extra = {}) {
            let fp = null;
            try { fp = await fpCached(); }
            catch (err) { warn('指纹获取失败：' + (err && err.message)); }

            if (!fp || !fp.visitorId) {
                warn('缺少指纹，本次访问未上报');
                return null;
            }

            const env = envInfo();
            const payload = Object.assign({
                fp: fp.visitorId,
                conf: (fp.confidence && typeof fp.confidence.score === 'number') ? fp.confidence.score : null
            }, env);

            const visit = buildVisit(extra);
            Object.assign(payload, {
                page: visit.page, path: visit.path, title: visit.title, ref: visit.ref
            });

            const res = await api().track(payload);

            const user = { id: res.userId, fp: fp.visitorId };
            document.dispatchEvent(new CustomEvent(TRACKED_EVENT, { detail: { user, visit } }));
            return { user, visit };
        },

        /* 用户索引（按创建时间倒序，与原版一致） */
        async getUsers() {
            const list = await fetchUserIndex();
            return list.slice().sort((a, b) => (b.created || 0) - (a.created || 0));
        },

        /* 单个用户完整数据；不存在时返回 null（与原版形状一致） */
        async getUser(id) {
            if (!id) return null;
            const idx = await fetchUserIndex();
            const u = idx.find(x => x.id === id);
            if (!u) return null;
            const data = await api().userVisits(id);
            const visits = (data.visits || []).slice(0, CFG.maxVisits);
            return {
                id: u.id,
                fp: u.fp,
                created: u.created,
                updated: u.updated || (visits.length ? visits[0].ts : u.created),
                conf: u.conf,
                ua: u.ua, screen: u.screen, dpr: u.dpr, lang: u.lang, tz: u.tz,
                ip: u.ip, country: u.country, city: u.city, asn: u.asn, asorg: u.asorg,
                visits
            };
        },

        /* 删除某用户的一条访问记录 */
        async removeVisit(userId, visitId) {
            if (!userId || !visitId) return false;
            await api().removeVisit(visitId);
            invalidateIndex();
            return true;
        },

        /* 删除用户（服务端连同明细一起删） */
        async removeUser(id) {
            if (!id) return false;
            await api().removeUser(id);
            invalidateIndex();
            return true;
        },

        /* 清空全部统计 */
        async clearAll() {
            await api().clearAll();
            invalidateIndex();
            return true;
        }
    };
    window.VisitTracker = VisitTracker;

    /* ==================== 5. 自动执行 ==================== */
    VisitTracker.loadApi = loadApi;
    VisitTracker.ready = (async () => {
        /* 无论是否自动上报，统计页都要用到 CFApi，所以先确保依赖就位 */
        try {
            await loadApi();
        } catch (err) {
            console.error('[VisitTracker] 依赖 api.js 加载失败:', err && err.message);
            return null;
        }

        if (CFG.disableAutoTrack) {
            log('disableAutoTrack 已开启，跳过自动记录');
            return null;
        }

        let fp = null;
        try {
            fp = await fpCached();
            console.groupCollapsed(
                '%c浏览器指纹 (FingerprintJS v' + fp.version + ')',
                'color:#F6821F;font-weight:bold'
            );
            console.log('visitorId:', fp.visitorId);
            console.log('置信度:', fp.confidence && fp.confidence.score);
            console.log('API:', api().apiBase);
            console.groupEnd();
            window.dispatchEvent(new CustomEvent(LIB_READY_EVENT, { detail: fp }));
        } catch (err) {
            console.error('[fingerprint.js] 获取指纹失败:', err && err.message);
            return null;
        }

        try {
            const result = await VisitTracker.track();
            if (!result) return null;
            const { user, visit } = result;
            console.groupCollapsed('%c本次访问已写入 Cloudflare D1', 'color:#F6821F;font-weight:bold');
            console.log('用户 ID:', user.id);
            console.log('指纹:', user.fp);
            console.log('页面:', visit.page);
            console.log('时间:', new Date(visit.ts).toLocaleString('zh-CN'));
            console.groupEnd();
            return result;
        } catch (err) {
            console.warn('[VisitTracker.CF] 上报失败（不做本地补偿）:', err && err.message);
            return null;
        }
    })();
})();
