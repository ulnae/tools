/**
 * tools-api — Cloudflare Worker（tools 站点统一数据 API，替代 GitHub Contents API 存储）
 *
 * 部署（详见同目录 README.md）：
 *   wrangler d1 create tools-data              → 把输出的 database_id 填入 wrangler.toml
 *   wrangler d1 execute tools-data --remote --file=schema.sql
 *   wrangler deploy
 *
 * 端点：
 *   公开：
 *     GET    /api/health                     连通性探测（国内可达性实测用）
 *     GET    /api/marker/types               标点类型列表（按创建时间）
 *     POST   /api/marker/types               新增类型（id 由服务端生成）
 *     PATCH  /api/marker/types/:id           更新类型
 *     DELETE /api/marker/types/:id           删除类型（连同其下标点）
 *     GET    /api/marker/points?type_id=     某类型标点（返回 FeatureCollection）
 *     POST   /api/marker/points              新增标点（Feature / FeatureCollection / 数组 / 扁平对象，id 由服务端生成）
 *     PATCH  /api/marker/points/:id          更新标点 { typeId?, coordinates, title, description }
 *     DELETE /api/marker/points/:id          删除标点
 *     POST   /api/feedback                   提交反馈 { type, content, contact, source }
 *     GET    /api/vault                      列出密文条目
 *     POST   /api/vault                      新增一条密文 { title, ciphertext }（id 与时间由服务端生成）
 *     PATCH  /api/vault/:id                  更新一条（baseUpdated 不匹配返回 409）
 *     DELETE /api/vault/:id                  删除一条
 *   管理（无鉴权，页面直接调用）：
 *     GET    /api/admin/feedback             反馈列表
 *     POST   /api/admin/feedback/delete      批量删除反馈 { ids: [] }
 */

const json = (data, status = 200, cors = {}) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors } });
const fail = (msg, status = 400, cors = {}) => json({ error: msg }, status, cors);

async function readJson(request) {
    try { return await request.json(); } catch (_) { return null; }
}

function corsFor(request, env) {
    /* ALLOW_ORIGIN 支持逗号分隔多个来源，例如：
       "https://ulnae.github.io,http://localhost:5500" */
    const allow = String(env.ALLOW_ORIGIN || '*');
    const origin = request.headers.get('Origin') || '';
    if (allow === '*') return { 'Access-Control-Allow-Origin': '*' };
    const list = allow.split(',').map(s => s.trim()).filter(Boolean);
    if (list.includes(origin)) return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    return { Vary: 'Origin' };   /* 来源不符：不带 ACAO，由浏览器侧拦截 */
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, '') || '/';
        const method = request.method;
        const cors = corsFor(request, env);

        if (method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: {
                ...cors,
                'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Max-Age': '86400'
            } });
        }

        try {
            return await route(request, env, { url, path, method, cors });
        } catch (e) {
            console.error(method, path, e);
            return fail('服务内部错误: ' + (e && e.message), 500, cors);
        }
    }
};

async function route(request, env, ctx) {
    const { path, method, cors } = ctx;

    if (method === 'GET' && path === '/api/health') {
        return json({ ok: true, time: Date.now(), colo: (request.cf && request.cf.colo) || '' }, 200, cors);
    }

    if (path.startsWith('/api/marker/')) return marker(request, env, ctx);

    if (method === 'POST' && path === '/api/feedback') return addFeedback(request, env, cors);

    if (path === '/api/vault' || path.startsWith('/api/vault/')) return vault(request, env, ctx);

    if (path.startsWith('/api/admin/')) return admin(request, env, ctx);

    return fail('not found', 404, cors);
}

/* ==================== 标点 ==================== */

/* 接受 FeatureCollection / 单个 Feature / 数组，统一转为行。
   也接受扁平的 { typeId, lng, lat, title, description }（utils/api.js 走这条）。
   id 与 created / updated 一律由服务端生成：客户端传了也直接丢掉，不参与入库。 */
function toFeatures(body) {
    if (!body) return [];
    const flat = !body.features && body.type !== 'Feature' && !Array.isArray(body) ? [body] : null;
    const list = flat || body.features || (body.type === 'Feature' ? [body] : (Array.isArray(body) ? body : []));
    return list.map(f => {
        const props = Object.assign({}, f.properties || {});
        const coord = (f.geometry && f.geometry.coordinates) || [f.lng, f.lat];
        return {
            type_id: String(props.type || f.typeId || body.typeId || ''),
            lng: Number(coord[0]),
            lat: Number(coord[1]),
            title: String(f.title != null ? f.title : (props.title || '')).slice(0, 200),
            description: String(f.description != null ? f.description : (props.description || '')).slice(0, 2000)
        };
    }).filter(f => f.type_id && isFinite(f.lng) && isFinite(f.lat));
}

/* 行 → GeoJSON Feature。properties 的字段名与表列名一致（title/description/type/created/updated），
   接口不做任何重命名。 */
function toFeatureCollection(rows) {
    return {
        type: 'FeatureCollection',
        features: rows.map(r => ({
            type: 'Feature',
            id: r.id,
            geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
            properties: {
                title: r.title || '',
                description: r.description || '',
                type: r.type_id,
                created: r.created || 0,
                updated: r.updated || 0
            }
        }))
    };
}

async function marker(request, env, { url, path, method, cors }) {
    const db = env.DB;
    const sub = path.slice('/api/marker/'.length);   /* types | types/:id | points | points/:id */
    const [kind, id] = sub.split('/');

    if (kind === 'types') {
        if (method === 'GET' && !id) {
            /* created 相同（批量导入）时用 rowid 兜底，保证顺序稳定且与写入顺序一致 */
            const { results } = await db.prepare('SELECT * FROM marker_types ORDER BY created, rowid').all();
            return json({ types: results }, 200, cors);
        }
        if (method === 'POST' && !id) {
            const b = await readJson(request);
            if (!b || !b.name) return fail('缺少类型名称', 400, cors);
            /* id 一律由服务端生成：客户端生成的 id 无法保证不冲突，也无法保证重试幂等 */
            const row = {
                id: crypto.randomUUID(),
                name: String(b.name).slice(0, 100),
                color: String(b.color || '#378ADD'),
                created: Date.now()
            };
            await db.prepare('INSERT INTO marker_types (id, name, color, created) VALUES (?,?,?,?)')
                .bind(row.id, row.name, row.color, row.created).run();
            return json(row, 200, cors);
        }
        if (method === 'PATCH' && id) {
            const b = await readJson(request);
            const sets = [], args = [];
            for (const k of ['name', 'color']) {
                if (b && b[k] !== undefined) { sets.push(`${k} = ?`); args.push(String(b[k])); }
            }
            if (!sets.length) return fail('无可更新字段', 400, cors);
            args.push(id);
            await db.prepare(`UPDATE marker_types SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
            return json({ ok: true, id }, 200, cors);
        }
        if (method === 'DELETE' && id) {
            await db.batch([
                db.prepare('DELETE FROM marker_points WHERE type_id = ?').bind(id),
                db.prepare('DELETE FROM marker_types WHERE id = ?').bind(id)
            ]);
            return json({ ok: true }, 200, cors);
        }
    }

    if (kind === 'points') {
        if (method === 'GET' && !id) {
            const typeId = url.searchParams.get('type_id');
            if (!typeId) return fail('缺少 type_id', 400, cors);
            const { results } = await db.prepare('SELECT * FROM marker_points WHERE type_id = ? ORDER BY created, rowid')
                .bind(typeId).all();
            return json(toFeatureCollection(results), 200, cors);
        }
        if (method === 'POST' && !id) {
            const b = await readJson(request);
            const feats = toFeatures(b);
            if (!feats.length) return fail('缺少有效 Feature 数据', 400, cors);
            const now = Date.now();
            const ids = feats.map(() => crypto.randomUUID());
            await db.batch(feats.map((f, i) => db.prepare(
                'INSERT INTO marker_points (id, type_id, lng, lat, title, description, created, updated) VALUES (?,?,?,?,?,?,?,?)'
            ).bind(ids[i], f.type_id, f.lng, f.lat, f.title, f.description, now, now)));
            return json({ ok: true, count: feats.length, ids }, 200, cors);
        }
        if (method === 'PATCH' && id) {
            const b = (await readJson(request)) || {};
            /* 兼容两种入参：扁平 { title, description }（utils/api.js 用）
               与旧 GeoJSON 风格的 { properties: { title, description } } */
            const p = b.properties || {};
            const title = b.title !== undefined ? b.title : p.title;
            const desc = b.description !== undefined ? b.description : p.description;
            const sets = [], args = [];
            /* 换类型只改归属，created 保持不变；目标类型必须存在，避免留下孤儿标点 */
            if (b.typeId !== undefined) {
                const nextType = String(b.typeId);
                const exists = await db.prepare('SELECT 1 FROM marker_types WHERE id = ?').bind(nextType).first();
                if (!exists) return fail('目标类型不存在', 400, cors);
                sets.push('type_id = ?'); args.push(nextType);
            }
            if (Array.isArray(b.coordinates) && isFinite(Number(b.coordinates[0]))) {
                sets.push('lng = ?', 'lat = ?');
                args.push(Number(b.coordinates[0]), Number(b.coordinates[1]));
            }
            if (title !== undefined) { sets.push('title = ?'); args.push(String(title).slice(0, 200)); }
            if (desc !== undefined) { sets.push('description = ?'); args.push(String(desc).slice(0, 2000)); }
            if (!sets.length) return fail('无可更新字段', 400, cors);
            /* updated 始终是服务端当前时间，客户端无法指定 */
            sets.push('updated = ?'); args.push(Date.now(), id);
            const r = await db.prepare(`UPDATE marker_points SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
            /* 目标行已被别处删除时不算失败：调用方的意图（该点不存在）已达成 */
            return json({ ok: true, id, changed: ((r.meta && r.meta.changes) || 0) > 0 }, 200, cors);
        }
        if (method === 'DELETE' && id) {
            await db.prepare('DELETE FROM marker_points WHERE id = ?').bind(id).run();
            return json({ ok: true }, 200, cors);
        }
    }

    return fail('not found', 404, cors);
}

/* ==================== 反馈（公开提交） ==================== */

async function addFeedback(request, env, cors) {
    const b = await readJson(request);
    if (!b || !b.content || !String(b.content).trim()) return fail('反馈内容不能为空', 400, cors);
    const row = {
        id: crypto.randomUUID(),
        type: String(b.type || '问题'),
        content: String(b.content).slice(0, 5000),
        contact: String(b.contact || '').slice(0, 200),
        source: String(b.source || '').slice(0, 300),
        created: Date.now()
    };
    await env.DB.prepare('INSERT INTO feedback (id, type, content, contact, source, created) VALUES (?,?,?,?,?,?)')
        .bind(row.id, row.type, row.content, row.contact, row.source, row.created).run();
    return json({ ok: true, id: row.id }, 200, cors);
}

/* ==================== 密文笔记（行级） ==================== */

/**
 * GET    /api/vault          列出全部条目（密文，客户端解密）
 * POST   /api/vault          新增一条 { title?, ciphertext }（created / updated 由服务端填写）
 * PATCH  /api/vault/:id      更新一条 { title?, ciphertext?, baseUpdated }
 *                            baseUpdated 与服务端不一致时返回 409（并发保护）
 * DELETE /api/vault/:id      删除一条
 */
async function vault(request, env, { path, method, cors }) {
    const db = env.DB;
    const sub = path.slice('/api/vault'.length).replace(/^\//, '');
    const id = sub ? decodeURIComponent(sub) : '';

    if (method === 'GET' && !id) {
        const { results } = await db.prepare(
            'SELECT id, title, ciphertext, created, updated FROM vault ORDER BY created ASC, id ASC'
        ).all();
        return json({ items: results || [] }, 200, cors);
    }

    if (method === 'POST' && !id) {
        const b = await readJson(request);
        if (!b || typeof b.ciphertext !== 'string' || !b.ciphertext) return fail('缺少 ciphertext', 400, cors);
        const now = Date.now();
        /* id 由服务端生成：客户端不再自己造 id，避免两台设备同时新建时撞号 */
        const newId = crypto.randomUUID();
        const row = {
            id: newId,
            title: String(b.title || '').slice(0, 200),
            ciphertext: b.ciphertext,
            created: now,
            updated: now
        };
        await db.prepare(
            'INSERT INTO vault (id, title, ciphertext, created, updated) VALUES (?,?,?,?,?)'
        ).bind(row.id, row.title, row.ciphertext, row.created, row.updated).run();
        return json(row, 200, cors);
    }

    if (method === 'PATCH' && id) {
        const b = (await readJson(request)) || {};
        const row = await db.prepare('SELECT title, ciphertext, created, updated FROM vault WHERE id = ?').bind(id).first();
        if (!row) return fail('记录不存在', 404, cors);
        /* 乐观锁：客户端读到的是哪个版本就必须基于哪个版本提交 */
        if (b.baseUpdated !== undefined && b.baseUpdated !== null &&
            Number(b.baseUpdated) !== Number(row.updated)) {
            return fail('该条记录已在其他设备上被修改，请刷新页面后再操作', 409, cors);
        }
        const title = b.title === undefined ? row.title : String(b.title);
        const ciphertext = b.ciphertext === undefined ? row.ciphertext : String(b.ciphertext);
        const now = Date.now();
        await db.prepare('UPDATE vault SET title = ?, ciphertext = ?, updated = ? WHERE id = ?')
            .bind(title, ciphertext, now, id).run();
        return json({ id, title, ciphertext, created: row.created, updated: now }, 200, cors);
    }

    if (method === 'DELETE' && id) {
        const r = await db.prepare('DELETE FROM vault WHERE id = ?').bind(id).run();
        return json({ ok: true, id, deleted: ((r.meta && r.meta.changes) || 0) > 0 }, 200, cors);
    }

    return fail('不支持的方法', 405, cors);
}

/* ==================== 管理端（反馈） ==================== */

async function admin(request, env, { path, method, cors }) {
    const db = env.DB;
    const sub = path.slice('/api/admin/'.length);

    if (method === 'GET' && sub === 'feedback') {
        const { results } = await db.prepare('SELECT * FROM feedback ORDER BY created DESC LIMIT 500').all();
        return json({ feedback: results }, 200, cors);
    }

    if (method === 'POST' && sub === 'feedback/delete') {
        const b = await readJson(request);
        const ids = (b && Array.isArray(b.ids)) ? b.ids.map(String) : [];
        if (!ids.length) return fail('缺少 ids', 400, cors);
        await db.prepare(`DELETE FROM feedback WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
        return json({ ok: true }, 200, cors);
    }

    return fail('not found', 404, cors);
}
