/**
 * api.js — Cloudflare Worker 数据 API 客户端
 *
 * 供标点 / 反馈 / vault 等模块（经由 store.js 动态注入，或页面显式引入）使用，
 * 统一封装：base 故障转移、超时、错误归一。
 *
 * 引入方式（绝对地址，任意目录层级通用）：
 *   <script src="https://ulnae.github.io/tools/utils/api.js"></script>
 *
 * 配置（可选，通过 CFAPI_CONFIG 覆盖）：
 *   apiBase     Worker 地址，默认指向当前已部署实例
 */
(function () {
    'use strict';

    const CFG = {
        /* apiBase 支持「字符串」或「数组」：数组时按顺序做故障转移。
           唯一入口：ulnae.localhost.cc —— Netlify 反代 → Cloudflare Worker。
           （tools-api...workers.dev 直连在国内 TCP 阶段就会超时，已移除，
             留作兜底只会让主地址异常时白等 8 秒。） */
        apiBase: ['https://ulnae.localhost.cc'],
        baseKey: 'cf_api_base',
        timeout: 8000
    };
    if (window.CFAPI_CONFIG && typeof window.CFAPI_CONFIG === 'object') {
        if (window.CFAPI_CONFIG.apiBase) CFG.apiBase = window.CFAPI_CONFIG.apiBase;
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
     * opts: { method, body }
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

        /* ---------- 诊断 ---------- */
        diagnose,
        health() { return request('/api/health'); },

        /* ---------- 标点 ---------- */

        markerTypes() { return request('/api/marker/types'); },
        /* 新增一律由服务端发号：不要传 id，返回体里带真实 id */
        addMarkerType(t) { return request('/api/marker/types', { method: 'POST', body: t }); },
        updateMarkerType(id, patch) { return request(`/api/marker/types/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }); },
        deleteMarkerType(id) { return request(`/api/marker/types/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
        markerPoints(typeId) { return request(`/api/marker/points?type_id=${encodeURIComponent(typeId)}`); },
        addMarkerPoints(payload) { return request('/api/marker/points', { method: 'POST', body: payload }); },
        updateMarkerPoint(id, patch) { return request(`/api/marker/points/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }); },
        deleteMarkerPoint(id) { return request(`/api/marker/points/${encodeURIComponent(id)}`, { method: 'DELETE' }); },

        /* ---------- 反馈 ---------- */

        addFeedback(f) { return request('/api/feedback', { method: 'POST', body: f }); },
        feedbackList() { return request('/api/admin/feedback'); },
        deleteFeedback(ids) { return request('/api/admin/feedback/delete', { method: 'POST', body: { ids } }); },

        /* ---------- 密文笔记（行级：一条密文一条记录） ---------- */

        /* 列表：{ items: [{ id, title, ciphertext, createdAt, updatedAt }] } */
        vaultItems() { return request('/api/vault'); },

        /* 新增：不传 id，服务端生号，返回 { id, createdAt, updatedAt } */
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
