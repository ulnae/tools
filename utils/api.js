/**
 * api.js — tools 站点数据接口（Cloudflare Worker + D1）
 *
 * 页面引入：
 *   <script src="https://ulnae.github.io/tools/utils/api.js"></script>
 *
 * 字段名与数据库列名、Worker JSON 完全一致，本层不做任何重命名：
 *   创建时间一律为 created，更新时间一律为 updated（毫秒时间戳）。
 * 新增记录的 id 一律由服务端生成（客户端不传 id）。
 *
 *   await Api.markerTypes.list()                      // [{ id, name, color, created }]
 *   await Api.markerTypes.create({ name, color })     // 返回新建的行
 *   await Api.markerTypes.update(id, { name, color })
 *   await Api.markerTypes.remove(id)                  // 连带删除该类型下的标点
 *
 *   await Api.markerPoints.list(typeId)               // FeatureCollection，properties 含 created / updated
 *   await Api.markerPoints.create(typeId, { lng, lat, title, description, created })
 *   await Api.markerPoints.update(id, { lng, lat, title, description })
 *   await Api.markerPoints.remove(id)
 *
 *   await Api.feedback.list()                         // [{ id, type, content, contact, source, created }]
 *   await Api.feedback.create({ type, content, contact, source })
 *   await Api.feedback.remove([id, ...])
 *
 *   await Api.vault.list()                            // [{ id, title, ciphertext, created, updated }]
 *   await Api.vault.create({ title, ciphertext })     // 返回新建的行
 *   await Api.vault.update(id, { title, ciphertext }, baseUpdated)   // 版本不符抛 409
 *   await Api.vault.remove(id)
 */
(function () {
    'use strict';

    /* Worker 唯一入口：Netlify 反代 → Cloudflare Worker。
       workers.dev 域名在国内 TCP 阶段就超时，因此不设备用地址。 */
    const BASE = 'https://ulnae.localhost.cc';
    const TIMEOUT = 8000;

    /* 统一请求：JSON 编解码、超时、错误归一 */
    async function request(method, path, body) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
        try {
            const res = await fetch(BASE + path, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: ctrl.signal,
                cache: 'no-store'
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                const err = new Error(data.error || `请求失败（HTTP ${res.status}）`);
                err.status = res.status;
                throw err;
            }
            return data;
        } catch (e) {
            if (e.status) throw e;
            throw new Error(/abort/i.test(e.message) ? '请求超时，请稍后重试' : '网络不可达：' + e.message);
        } finally {
            clearTimeout(timer);
        }
    }

    const id = encodeURIComponent;

    /* ==================== 标点类型 ==================== */

    const markerTypes = {
        async list() {
            return (await request('GET', '/api/marker/types')).types || [];
        },
        create({ name, color }) {
            return request('POST', '/api/marker/types', { name, color });
        },
        update(typeId, { name, color }) {
            return request('PATCH', `/api/marker/types/${id(typeId)}`, { name, color });
        },
        remove(typeId) {
            return request('DELETE', `/api/marker/types/${id(typeId)}`);
        }
    };

    /* ==================== 标点 ==================== */

    const markerPoints = {
        async list(typeId) {
            const fc = await request('GET', `/api/marker/points?type_id=${id(typeId)}`);
            return { type: 'FeatureCollection', features: (fc && fc.features) || [] };
        },
        /* 新增可传单个点或数组；created 不传则由服务端取当前时间 */
        create(typeId, point) {
            const list = Array.isArray(point) ? point : [point];
            return request('POST', '/api/marker/points', list.map(p => ({
                typeId,
                lng: Number(p.lng),
                lat: Number(p.lat),
                title: p.title || '',
                description: p.description || '',
                created: p.created
            })));
        },
        update(pointId, { lng, lat, title, description }) {
            return request('PATCH', `/api/marker/points/${id(pointId)}`, {
                coordinates: [Number(lng), Number(lat)],
                title: title || '',
                description: description || ''
            });
        },
        remove(pointId) {
            return request('DELETE', `/api/marker/points/${id(pointId)}`);
        }
    };

    /* ==================== 反馈 ==================== */

    const feedback = {
        async list() {
            return (await request('GET', '/api/admin/feedback')).feedback || [];
        },
        create({ type, content, contact, source }) {
            return request('POST', '/api/feedback', { type, content, contact, source });
        },
        remove(ids) {
            return request('POST', '/api/admin/feedback/delete', { ids });
        }
    };

    /* ==================== 密文笔记 ==================== */

    const vault = {
        async list() {
            return (await request('GET', '/api/vault')).items || [];
        },
        create({ title, ciphertext }) {
            return request('POST', '/api/vault', { title, ciphertext });
        },
        update(itemId, { title, ciphertext }, baseUpdated) {
            const body = { title, ciphertext };
            if (baseUpdated !== undefined && baseUpdated !== null) body.baseUpdated = baseUpdated;
            return request('PATCH', `/api/vault/${id(itemId)}`, body);
        },
        remove(itemId) {
            return request('DELETE', `/api/vault/${id(itemId)}`);
        }
    };

    window.Api = { markerTypes, markerPoints, feedback, vault };
})();
