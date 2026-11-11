/**
 * api.js — Cloudflare Worker 数据 API 客户端（测试版配套）
 *
 * 一期测试版专用：与 utils/fingerprint_test.js 搭配，把访客统计的
 * 存储从 GitHub 切换到 Cloudflare D1（经 tools-api Worker）。
 * 原 utils/fingerprint.js（GitHub 存储）保持不动，二者互不影响。
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
        apiBase: 'https://tools-api.yyh3531.workers.dev',
        tokenKey: 'cf_admin_token',
        timeout: 15000
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

    /**
     * 统一请求：超时 15s、JSON 编解码、错误归一（throw Error(msg)）。
     * opts: { method, body, auth }
     */
    async function request(path, opts = {}) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), CFG.timeout);
        const headers = { 'Content-Type': 'application/json' };
        if (opts.auth) headers.Authorization = 'Bearer ' + getToken();

        let res;
        try {
            res = await fetch(CFG.apiBase.replace(/\/+$/, '') + path, {
                method: opts.method || 'GET',
                headers,
                body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
                signal: ctrl.signal,
                cache: 'no-store'
            });
        } catch (e) {
            clearTimeout(timer);
            throw new Error(/abort/i.test(e && e.message) ? '请求超时' : '网络错误: ' + (e && e.message));
        }
        clearTimeout(timer);

        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ('API ' + res.status));
        return data;
    }

    window.CFApi = {
        get apiBase() { return CFG.apiBase; },
        getToken, setToken,

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

        /* ---------- 密文包（二期用） ---------- */

        getVault() { return request('/api/vault'); },
        putVault(blob) { return request('/api/vault', { method: 'PUT', body: { blob } }); },

        /* ---------- 探测 ---------- */

        health() { return request('/api/health'); }
    };
})();
