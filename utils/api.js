/**
 * api.js — Cloudflare Worker 数据 API 客户端
 *
 * 供 utils/fingerprint.js（访客统计）与二期模块（标点/反馈/vault）共用，
 * 统一封装：base 故障转移、超时、错误归一、admin token 注入。
 *
 * 通常无需在页面里手动引入：fingerprint.js 会自动加载本文件；
 * 二期页面若直接用 CFApi，再显式加一行 <script> 即可。
 *
 * 引入方式（绝对地址，任意目录层级通用）：
 *   <script src="https://ulnae.github.io/tools/utils/tracker-config.js"></script>
 *   <script src="https://ulnae.github.io/tools/utils/api.js"></script>
 *
 * 配置（可选，通过 VISIT_TRACKER_CONFIG 覆盖）：
 *   apiBase     Worker 地址，默认指向当前已部署实例
 *   adminToken  管理密钥；未配置时从 sessionStorage 的 cf_admin_token 读取
 *
 * 后续二期（标点/反馈/vault 迁移）复用本文件，方法已预留。
 */
(function () {
    'use strict';

    const CFG = {
        /* apiBase 支持「字符串」或「数组」：数组时按顺序做故障转移。
           唯一入口：ulnae.localhost.cc —— Netlify 反代 → Cloudflare Worker。
           （tools-api...workers.dev 直连在国内 TCP 阶段就会超时，已移除，
             留作兜底只会让主地址异常时白等 8 秒。） */
        apiBase: ['https://ulnae.localhost.cc'],
        tokenKey: 'cf_admin_token',
        baseKey: 'cf_api_base',
        timeout: 8000
    };
    if (window.VISIT_TRACKER_CONFIG && typeof window.VISIT_TRACKER_CONFIG === 'object') {
        if (window.VISIT_TRACKER_CONFIG.apiBase) CFG.apiBase = window.VISIT_TRACKER_CONFIG.apiBase;
        if (window.VISIT_TRACKER_CONFIG.adminToken) CFG.adminToken = window.VISIT_TRACKER_CONFIG.adminToken;
    }

    function getToken() {
        if (CFG.adminToken) return CFG.adminToken;
        try { return sessionStorage.getItem(CFG.tokenKey) || ''; } catch (_) { return ''; }
    }

    function setToken(t) {
        try {
            if (t) sessionStorage.setItem(CFG.tokenKey, t);
            else sessionStorage.removeItem(CFG.tokenKey);
        } catch (_) { /* 隐私模式下静默失败 */ }
    }

    /* 解析候选地址：内置配置 + 会话内追加（CFApi.addBase），上次成功的排最前 */
    function baseList() {
        const raw = CFG.apiBase;
        let list = (Array.isArray(raw) ? raw : [raw])
            .map(s => String(s || '').replace(/\/+$/, ''))
            .filter(Boolean);
        try {
            const extra = JSON.parse(sessionStorage.getItem('cf_api_bases') || '[]');
            if (Array.isArray(extra)) {
                extra.forEach(b => {
                    const s = String(b || '').replace(/\/+$/, '');
                    if (s && !list.includes(s)) list.push(s);
                });
            }
        } catch (_) { /* ignore */ }

        let best = '';
        try { best = sessionStorage.getItem(CFG.baseKey) || ''; } catch (_) { /* ignore */ }
        const i = list.indexOf(best);
        if (i > 0) list.unshift(list.splice(i, 1)[0]);
        return list;
    }

    function rememberBase(base) {
        try { sessionStorage.setItem(CFG.baseKey, base); } catch (_) { /* ignore */ }
    }

    /* 单地址请求：成功返回数据，失败抛出带类型标记的错误 */
    async function requestOne(base, path, opts) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), CFG.timeout);
        const headers = { 'Content-Type': 'application/json' };
        if (opts.auth) headers.Authorization = 'Bearer ' + getToken();

        try {
            const res = await fetch(base + path, {
                method: opts.method || 'GET',
                headers,
                body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
                signal: ctrl.signal,
                cache: 'no-store'
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                const e = new Error(data.error || ('API ' + res.status));
                e.status = res.status;          // 有状态码＝已到达服务端，不再换地址重试
                throw e;
            }
            return data;
        } catch (e) {
            if (e && e.status) throw e;
            const timeout = /abort/i.test(e && e.message);
            const err = new Error(timeout ? '请求超时' : '网络不可达: ' + (e && e.message));
            err.network = true;                 // 网络层失败：可尝试下一个地址
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * 统一请求：多地址故障转移、超时 8s、JSON 编解码、错误归一。
     * opts: { method, body, auth }
     */
    async function request(path, opts = {}) {
        const list = baseList();
        let last = null;
        for (const base of list) {
            try {
                const data = await requestOne(base, path, opts);
                rememberBase(base);
                return data;
            } catch (e) {
                if (!e.network) throw e;         // 服务端已响应（4xx/5xx），不重试其他地址
                last = e;
            }
        }
        const hint = list.length > 1
            ? `（已尝试 ${list.length} 个地址）`
            : '（若为 workers.dev 域名，可能是 DNS 污染，请绑定自定义域名）';
        const err = new Error((last ? last.message : '无可用地址') + hint);
        err.network = true;
        throw err;
    }

    /* 逐地址诊断：返回每个地址的可达性、耗时与响应，供 ping_test.html 使用 */
    async function diagnose(path = '/api/health') {
        const out = [];
        for (const base of baseList()) {
            const t0 = performance.now();
            try {
                const data = await requestOne(base, path, {});
                out.push({ base, ok: true, ms: Math.round(performance.now() - t0), data });
            } catch (e) {
                out.push({ base, ok: false, ms: Math.round(performance.now() - t0), error: e.message });
            }
        }
        return out;
    }

    window.CFApi = {
        /** 当前候选地址列表（首个为优先） */
        get apiBase() { return baseList(); },
        /** 追加一个候选地址（例如刚绑定的自定义域名），存入 sessionStorage 后立即生效 */
        addBase(base) {
            try {
                const list = JSON.parse(sessionStorage.getItem('cf_api_bases') || '[]');
                if (base && !list.includes(base)) list.push(base);
                sessionStorage.setItem('cf_api_bases', JSON.stringify(list));
            } catch (_) { /* ignore */ }
        },
        getToken, setToken,

        /* ---------- 诊断 ---------- */
        diagnose,
        health() { return request('/api/health'); },

        /* ---------- 访客统计（公开写 / 管理读） ---------- */

        /** 上报一次访问：payload 含 fp/conf/ua/screen/dpr/lang/tz/page/path/title/ref */
        track(payload) { return request('/api/track', { method: 'POST', body: payload }); },

        /** 全站聚合：{ users, visits, activeWeek, byDay, byPage, byGeo } */
        stats() { return request('/api/admin/stats', { auth: true }); },

        /** 用户列表（含 visitCount），limit 最大 500 */
        users(limit = 500, offset = 0) {
            return request(`/api/admin/users?limit=${limit}&offset=${offset}`, { auth: true });
        },

        /** 单用户访问明细：{ visits: [...] } */
        userVisits(id) { return request(`/api/admin/users/${encodeURIComponent(id)}/visits`, { auth: true }); },

        /** 删除用户（连同其访问明细） */
        removeUser(id) { return request(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE', auth: true }); },

        /** 删除单条访问 */
        removeVisit(visitId) { return request(`/api/admin/visits/${encodeURIComponent(visitId)}`, { method: 'DELETE', auth: true }); },

        /** 清空全部统计 */
        clearAll() { return request('/api/admin/clear', { method: 'POST', auth: true }); },

        /* ---------- 标点（二期用，Worker 端已就绪） ---------- */

        markerTypes() { return request('/api/marker/types'); },
        addMarkerType(t) { return request('/api/marker/types', { method: 'POST', body: t }); },
        updateMarkerType(id, patch) { return request(`/api/marker/types/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }); },
        deleteMarkerType(id) { return request(`/api/marker/types/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
        markerPoints(typeId) { return request(`/api/marker/points?type_id=${encodeURIComponent(typeId)}`); },
        addMarkerPoints(payload) { return request('/api/marker/points', { method: 'POST', body: payload }); },
        updateMarkerPoint(id, patch) { return request(`/api/marker/points/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }); },
        deleteMarkerPoint(id) { return request(`/api/marker/points/${encodeURIComponent(id)}`, { method: 'DELETE' }); },

        /* ---------- 反馈（二期用） ---------- */

        addFeedback(f) { return request('/api/feedback', { method: 'POST', body: f }); },
        feedbackList() { return request('/api/admin/feedback', { auth: true }); },
        deleteFeedback(ids) { return request('/api/admin/feedback/delete', { method: 'POST', body: { ids }, auth: true }); },

        /* ---------- 密文笔记（行级：一条密文一条记录） ---------- */

        /* 列表：{ items: [{ id, title, ciphertext, createdAt, updatedAt }] } */
        vaultItems() { return request('/api/vault'); },

        /* 新增：同 id 幂等（重复提交不会产生第二条） */
        addVaultItem(item) { return request('/api/vault', { method: 'POST', body: item }); },

        /* 更新：带 baseUpdatedAt 时服务端做条件更新，被别处改过会抛 409 */
        updateVaultItem(id, patch, baseUpdatedAt) {
            const body = Object.assign({}, patch);
            if (baseUpdatedAt !== undefined && baseUpdatedAt !== null) body.baseUpdatedAt = baseUpdatedAt;
            return request('/api/vault/' + encodeURIComponent(id), { method: 'PATCH', body });
        },

        deleteVaultItem(id) {
            return request('/api/vault/' + encodeURIComponent(id), { method: 'DELETE' });
        }
    };
})();
