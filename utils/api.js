/**
 * api.js — tools 站点数据接口（Cloudflare Worker + D1）
 *
 * 页面引入：
 *   <script src="https://ulnae.github.io/tools/utils/api.js"></script>
 *
 * 按资源调用，新增记录的 id 一律由服务端生成（客户端不传 id）：
 *   await Api.markerTypes.list()                      // [{ id, name, color, created_at }]
 *   await Api.markerTypes.create({ name, color })     // 返回新建的类型
 *   await Api.markerTypes.update(id, { name, color })
 *   await Api.markerTypes.remove(id)                  // 连带删除该类型下的标点
 *
 *   await Api.markerPoints.list(typeId)               // GeoJSON FeatureCollection
 *   await Api.markerPoints.create(typeId, { lng, lat, title, description })
 *   await Api.markerPoints.update(id, { lng, lat, title, description })
 *   await Api.markerPoints.remove(id)
 *
 *   await Api.feedback.list()                         // [{ id, type, content, contact, source, created_at }]
 *   await Api.feedback.create({ type, content, contact, source })
 *   await Api.feedback.remove([id, ...])
 *
 *   await Api.vault.list()                            // [{ id, title, ciphertext, createdAt, updatedAt }]
 *   await Api.vault.create({ title, ciphertext, createdAt })
 *   await Api.vault.update(id, { title, ciphertext }, baseUpdatedAt)   // 版本不符抛 409
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

    /* D1 列名是 created，统一成 created_at 给页面 */
    const toType = t => ({ id: t.id, name: t.name || '', color: t.color || '', created_at: t.created || 0 });

    const markerTypes = {
        async list() {
            const r = await request('GET', '/api/marker/types');
            return (r.types || []).map(toType);
        },
        async create({ name, color }) {
            return toType(await request('POST', '/api/marker/types', { name, color }));
        },
        update(typeId, { name, color }) {
            return request('PATCH', `/api/marker/types/${id(typeId)}`, { name, color });
        },
        remove(typeId) {
            return request('DELETE', `/api/marker/types/${id(typeId)}`);
        }
    };

    /* ==================== 标点 ==================== */

    /* 扁平入参 → Worker 接受的行数据 */
    const toPoint = (typeId, p) => ({
        typeId,
        lng: Number(p.lng),
        lat: Number(p.lat),
        title: p.title || '',
        description: p.description || '',
        created: p.createdAt || Date.now()
    });

    const markerPoints = {
        async list(typeId) {
            const fc = await request('GET', `/api/marker/points?type_id=${id(typeId)}`);
            return { type: 'FeatureCollection', features: (fc && fc.features) || [] };
        },
        create(typeId, point) {
            const list = Array.isArray(point) ? point : [point];
            return request('POST', '/api/marker/points', {
                typeId,
                features: list.map(p => toPoint(typeId, p))
            });
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
            const r = await request('GET', '/api/admin/feedback');
            return r.feedback || [];
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
            const r = await request('GET', '/api/vault');
            return r.items || [];
        },
        async create({ title, ciphertext, createdAt }) {
            const r = await request('POST', '/api/vault', { title, ciphertext, createdAt });
            return { id: r.id, title: title || '', ciphertext, createdAt: r.createdAt, updatedAt: r.updatedAt };
        },
        update(itemId, { title, ciphertext }, baseUpdatedAt) {
            const body = { title, ciphertext };
            if (baseUpdatedAt !== undefined && baseUpdatedAt !== null) body.baseUpdatedAt = baseUpdatedAt;
            return request('PATCH', `/api/vault/${id(itemId)}`, body);
        },
        remove(itemId) {
            return request('DELETE', `/api/vault/${id(itemId)}`);
        }
    };

    window.Api = { markerTypes, markerPoints, feedback, vault };
})();
