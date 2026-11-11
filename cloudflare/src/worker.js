/**
 * tools-api — Cloudflare Worker（tools 站点统一数据 API，替代 GitHub Contents API 存储）
 *
 * 部署（见项目根 README 或迁移步骤文档）：
 *   wrangler d1 create tools-data              → 把输出的 database_id 填入 wrangler.toml
 *   wrangler d1 execute tools-data --remote --file=schema.sql
 *   wrangler secret put ADMIN_TOKEN            → 输入一个随机长串（管理端鉴权）
 *   wrangler deploy
 *
 * 端点：
 *   公开：
 *     GET    /api/health                     连通性探测（国内可达性实测用）
 *     POST   /api/track                      访客统计上报（服务端取 IP/地理，入库即脱敏）
 *     GET    /api/marker/types               标点类型列表
 *     POST   /api/marker/types               新增类型
 *     PATCH  /api/marker/types/:id           更新类型
 *     DELETE /api/marker/types/:id           删除类型（连同其下标点）
 *     GET    /api/marker/points?type_id=     某类型标点（返回 FeatureCollection）
 *     POST   /api/marker/points              新增标点（Feature / FeatureCollection / 数组）
 *     PATCH  /api/marker/points/:id          更新标点 { coordinates, properties }
 *     DELETE /api/marker/points/:id          删除标点
 *     POST   /api/feedback                   提交反馈 { type, content, contact, source }
 *     GET    /api/vault                      读密文包
 *     PUT    /api/vault                      写密文包 { blob }
 *   管理（Header: Authorization: Bearer <ADMIN_TOKEN>）：
 *     GET    /api/admin/stats                全站聚合（总量/按天/按页面/按地区）
 *     GET    /api/admin/users?limit=&offset= 用户列表（含访问次数）
 *     GET    /api/admin/users/:id/visits     单用户访问明细
 *     DELETE /api/admin/users/:id            删除用户及其访问
 *     DELETE /api/admin/visits/:vid          删除单条访问
 *     GET    /api/admin/feedback             反馈列表
 *     POST   /api/admin/feedback/delete      批量删除反馈 { ids: [] }
 *     POST   /api/admin/clear                清空全部统计
 *     POST   /api/admin/import               存量数据导入（幂等，可重复执行）
 */

const json = (data, status = 200, cors = {}) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors } });
const fail = (msg, status = 400, cors = {}) => json({ error: msg }, status, cors);

/* IP 入库即脱敏：IPv4 保留前三段（/24），IPv6 保留前三组（/48） */
function maskIp(ip) {
    if (!ip) return '';
    if (ip.includes('.')) return ip.split('.').slice(0, 3).join('.') + '.0';
    if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + '::';
    return '';
}

const dayOf = ts => new Date(ts).toISOString().slice(0, 10);
const safeJson = s => { try { return JSON.parse(s) || {}; } catch (_) { return {}; } };

async function readJson(request) {
    try { return await request.json(); } catch (_) { return null; }
}

function isAdmin(request, env) {
    const auth = request.headers.get('Authorization') || '';
    return Boolean(env.ADMIN_TOKEN) && auth === 'Bearer ' + env.ADMIN_TOKEN;
}

/* 取真实客户端 IP：
   - 直连（workers.dev 或 CF 自定义域）：CF-Connecting-IP 由边缘写入，最可信；
   - 经反代（Netlify 等）：CF-Connecting-IP 是反代出口 IP，真实访客 IP 在
     X-Forwarded-For 第 1 位——仅在显式配置 TRUST_PROXY=true 时信任，
     避免直连模式下被伪造头污染。 */
function clientIp(request, env) {
    if (String(env.TRUST_PROXY || '').toLowerCase() === 'true') {
        const xff = request.headers.get('X-Forwarded-For') || '';
        const first = xff.split(',')[0].trim();
        if (first) return first;
    }
    return request.headers.get('CF-Connecting-IP') || '';
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
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

    if (method === 'POST' && path === '/api/track') return track(request, env, cors);

    if (path.startsWith('/api/marker/')) return marker(request, env, ctx);

    if (method === 'POST' && path === '/api/feedback') return addFeedback(request, env, cors);

    if (path === '/api/vault' && (method === 'GET' || method === 'PUT')) return vault(request, env, method, cors);

    if (path.startsWith('/api/admin/')) {
        if (!isAdmin(request, env)) return fail('未授权', 401, cors);
        return admin(request, env, ctx);
    }

    return fail('not found', 404, cors);
}

/* ==================== 访客统计 ==================== */

async function track(request, env, cors) {
    /* 简易限流：RATE_LIMITER 绑定不存在或调用异常时静默放行 */
    try {
        const key = request.headers.get('CF-Connecting-IP') || 'anon';
        const rl = env.RATE_LIMITER && await env.RATE_LIMITER.limit({ key });
        if (rl && rl.success === false) return fail('请求过于频繁', 429, cors);
    } catch (_) { /* 限流器故障不影响主流程 */ }

    const b = await readJson(request);
    if (!b || !b.fp || typeof b.fp !== 'string' || b.fp.length < 8) return fail('缺少有效指纹', 400, cors);

    const cf = request.cf || {};
    const now = Date.now();
    const conf = typeof b.conf === 'number' ? b.conf : null;

    /* 反代模式下 cf.* 是反代出口（如 Netlify 新加坡）的地理，写进去只会误导，
       宁可留空，后续如需地理可基于真实 IP 服务端查询并缓存。 */
    const geoOk = String(env.TRUST_PROXY || '').toLowerCase() !== 'true';

    const user = await env.DB.prepare(
        `INSERT INTO users (id, fp, created, updated, conf, ua, screen, dpr, lang, tz, ip, country, city, asn, asorg)
         VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(fp) DO UPDATE SET
             updated = excluded.updated, conf = excluded.conf,
             ip = excluded.ip, country = excluded.country, city = excluded.city,
             asn = excluded.asn, asorg = excluded.asorg
         RETURNING id`
    ).bind(
        crypto.randomUUID(), b.fp, now, conf,
        String(b.ua || ''), String(b.screen || ''), b.dpr == null ? null : Number(b.dpr),
        String(b.lang || ''), String(b.tz || ''),
        maskIp(clientIp(request, env)),
        geoOk ? String(cf.country || '') : '',
        geoOk ? String(cf.city || '') : '',
        geoOk && cf.asn ? 'AS' + cf.asn : '', geoOk ? String(cf.asOrganization || '') : ''
    ).first();

    const visitId = crypto.randomUUID();
    await env.DB.prepare(
        `INSERT OR IGNORE INTO visits (id, user_id, ts, day, page, path, title, ref)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(visitId, user.id, now, dayOf(now),
        String(b.page || ''), String(b.path || ''), String(b.title || ''), String(b.ref || '')
    ).run();

    return json({ ok: true, userId: user.id, visitId }, 200, cors);
}

/* ==================== 标点 ==================== */

/* 接受 FeatureCollection / 单个 Feature / 数组，统一转为行 */
function toFeatures(body) {
    if (!body) return [];
    const list = body.features || (body.type === 'Feature' ? [body] : (Array.isArray(body) ? body : []));
    return list.map(f => {
        const props = Object.assign({}, f.properties || {});
        const typeId = props.type || body.typeId || '';
        const coord = (f.geometry && f.geometry.coordinates) || [];
        return {
            id: f.id || props.id || '',
            type_id: typeId,
            lng: Number(coord[0]),
            lat: Number(coord[1]),
            properties: Object.assign(props, { type: typeId }),
            created: props.created
        };
    }).filter(f => f.type_id && isFinite(f.lng) && isFinite(f.lat));
}

function toFeatureCollection(rows) {
    return {
        type: 'FeatureCollection',
        features: rows.map(r => ({
            type: 'Feature',
            id: r.id,
            geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
            properties: Object.assign(safeJson(r.props), { type: r.type_id, created: r.created })
        }))
    };
}

async function marker(request, env, { url, path, method, cors }) {
    const db = env.DB;
    const sub = path.slice('/api/marker/'.length);   /* types | types/:id | points | points/:id */
    const [kind, id] = sub.split('/');

    if (kind === 'types') {
        if (method === 'GET' && !id) {
            const { results } = await db.prepare('SELECT * FROM marker_types ORDER BY sort, created').all();
            return json({ types: results }, 200, cors);
        }
        if (method === 'POST' && !id) {
            const b = await readJson(request);
            if (!b || !b.name) return fail('缺少类型名称', 400, cors);
            const row = {
                id: b.id || crypto.randomUUID(),
                name: String(b.name),
                color: String(b.color || '#378ADD'),
                sort: Number(b.sort || 0),
                created: Date.now()
            };
            await db.prepare('INSERT OR IGNORE INTO marker_types (id, name, color, sort, created) VALUES (?,?,?,?,?)')
                .bind(row.id, row.name, row.color, row.sort, row.created).run();
            return json(row, 200, cors);
        }
        if (method === 'PATCH' && id) {
            const b = await readJson(request);
            const sets = [], args = [];
            for (const k of ['name', 'color', 'sort']) {
                if (b && b[k] !== undefined) { sets.push(`${k} = ?`); args.push(k === 'sort' ? Number(b[k]) : String(b[k])); }
            }
            if (!sets.length) return fail('无可更新字段', 400, cors);
            args.push(id);
            await db.prepare(`UPDATE marker_types SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
            return json({ ok: true }, 200, cors);
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
            const { results } = await db.prepare('SELECT * FROM marker_points WHERE type_id = ? ORDER BY created')
                .bind(typeId).all();
            return json(toFeatureCollection(results), 200, cors);
        }
        if (method === 'POST' && !id) {
            const b = await readJson(request);
            const feats = toFeatures(b);
            if (!feats.length) return fail('缺少有效 Feature 数据', 400, cors);
            const now = Date.now();
            await db.batch(feats.map(f => db.prepare(
                'INSERT OR REPLACE INTO marker_points (id, type_id, lng, lat, props, created, updated) VALUES (?,?,?,?,?,?,?)'
            ).bind(f.id || crypto.randomUUID(), f.type_id, f.lng, f.lat,
                JSON.stringify(f.properties), f.created || now, now)));
            return json({ ok: true, count: feats.length }, 200, cors);
        }
        if (method === 'PATCH' && id) {
            const b = await readJson(request);
            const sets = [], args = [];
            if (b && Array.isArray(b.coordinates) && isFinite(Number(b.coordinates[0]))) {
                sets.push('lng = ?', 'lat = ?');
                args.push(Number(b.coordinates[0]), Number(b.coordinates[1]));
            }
            if (b && b.properties) { sets.push('props = ?'); args.push(JSON.stringify(b.properties)); }
            if (!sets.length) return fail('无可更新字段', 400, cors);
            sets.push('updated = ?'); args.push(Date.now(), id);
            await db.prepare(`UPDATE marker_points SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
            return json({ ok: true }, 200, cors);
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
        created_at: Date.now()
    };
    await env.DB.prepare('INSERT INTO feedback (id, type, content, contact, source, created_at) VALUES (?,?,?,?,?,?)')
        .bind(row.id, row.type, row.content, row.contact, row.source, row.created_at).run();
    return json({ ok: true, id: row.id }, 200, cors);
}

/* ==================== 密文包 ==================== */

async function vault(request, env, method, cors) {
    if (method === 'GET') {
        const row = await env.DB.prepare("SELECT blob, updated FROM vault WHERE id = 'main'").first();
        return json({ blob: row ? row.blob : '', updated: row ? row.updated : 0 }, 200, cors);
    }
    const b = await readJson(request);
    if (!b || typeof b.blob !== 'string') return fail('缺少 blob', 400, cors);
    const now = Date.now();
    await env.DB.prepare(
        "INSERT INTO vault (id, blob, updated) VALUES ('main', ?, ?) ON CONFLICT(id) DO UPDATE SET blob = excluded.blob, updated = excluded.updated"
    ).bind(b.blob, now).run();
    return json({ ok: true, updated: now }, 200, cors);
}

/* ==================== 管理端 ==================== */

async function admin(request, env, { url, path, method, cors }) {
    const db = env.DB;
    const sub = path.slice('/api/admin/'.length);

    if (method === 'GET' && sub === 'stats') {
        const [u, v, active, byDay, byPage, byGeo] = await db.batch([
            db.prepare('SELECT COUNT(*) c FROM users'),
            db.prepare('SELECT COUNT(*) c FROM visits'),
            db.prepare('SELECT COUNT(*) c FROM users WHERE updated > ?').bind(Date.now() - 7 * 86400e3),
            db.prepare('SELECT day, COUNT(*) c FROM visits GROUP BY day ORDER BY day DESC LIMIT 60'),
            db.prepare('SELECT page, COUNT(*) c FROM visits GROUP BY page ORDER BY c DESC LIMIT 20'),
            db.prepare('SELECT COALESCE(country, "") country, COALESCE(city, "") city, COUNT(*) c FROM users GROUP BY country, city ORDER BY c DESC LIMIT 20')
        ]);
        return json({
            users: u.results[0].c,
            visits: v.results[0].c,
            activeWeek: active.results[0].c,
            byDay: byDay.results,
            byPage: byPage.results,
            byGeo: byGeo.results
        }, 200, cors);
    }

    if (method === 'GET' && sub === 'users') {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 500);
        const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
        const { results } = await db.prepare(
            `SELECT u.*, (SELECT COUNT(*) FROM visits v WHERE v.user_id = u.id) AS visitCount
             FROM users u ORDER BY u.updated DESC LIMIT ? OFFSET ?`
        ).bind(limit, offset).all();
        return json({ users: results }, 200, cors);
    }

    if (method === 'GET' && /^users\/[^/]+\/visits$/.test(sub)) {
        const userId = sub.split('/')[1];
        const { results } = await db.prepare('SELECT * FROM visits WHERE user_id = ? ORDER BY ts DESC LIMIT 500')
            .bind(userId).all();
        return json({ visits: results }, 200, cors);
    }

    if (method === 'DELETE' && /^users\//.test(sub)) {
        const userId = sub.slice('users/'.length);
        await db.batch([
            db.prepare('DELETE FROM visits WHERE user_id = ?').bind(userId),
            db.prepare('DELETE FROM users WHERE id = ?').bind(userId)
        ]);
        return json({ ok: true }, 200, cors);
    }

    if (method === 'DELETE' && /^visits\//.test(sub)) {
        await db.prepare('DELETE FROM visits WHERE id = ?').bind(sub.slice('visits/'.length)).run();
        return json({ ok: true }, 200, cors);
    }

    if (method === 'GET' && sub === 'feedback') {
        const { results } = await db.prepare('SELECT * FROM feedback ORDER BY created_at DESC LIMIT 500').all();
        return json({ feedback: results }, 200, cors);
    }

    if (method === 'POST' && sub === 'feedback/delete') {
        const b = await readJson(request);
        const ids = (b && Array.isArray(b.ids)) ? b.ids.map(String) : [];
        if (!ids.length) return fail('缺少 ids', 400, cors);
        await db.prepare(`DELETE FROM feedback WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
        return json({ ok: true }, 200, cors);
    }

    if (method === 'POST' && sub === 'clear') {
        await db.batch([db.prepare('DELETE FROM visits'), db.prepare('DELETE FROM users')]);
        return json({ ok: true }, 200, cors);
    }

    if (method === 'POST' && sub === 'import') return importData(request, env, cors);

    return fail('not found', 404, cors);
}

/* 存量导入：全部 INSERT OR IGNORE / OR REPLACE，可重复执行 */
async function importData(request, env, cors) {
    const b = await readJson(request);
    if (!b) return fail('缺少导入数据', 400, cors);
    const db = env.DB;
    const now = Date.now();
    const out = {};

    const chunk = (arr, n) => {
        const r = [];
        for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n));
        return r;
    };
    const run = async (rows, makeStmt) => {
        let n = 0;
        for (const part of chunk(rows, 40)) {
            await db.batch(part.map(makeStmt));
            n += part.length;
        }
        return n;
    };

    if (Array.isArray(b.users)) {
        /* 按 fp 归并：D1 里可能已有同指纹用户（正式切换后、迁移前产生的新记录）。
           users.fp 有 UNIQUE 约束，直接 INSERT OR IGNORE 会静默丢弃老记录，
           而老记录的 visits 会挂在已不存在的 user_id 上变成孤儿。这里先建
           旧 id → 现 id 的映射，visits 一并改写。 */
        const rows = (await db.prepare('SELECT id, fp, created FROM users').all()).results || [];
        const fpToId = new Map(rows.map(r => [r.fp, r]));
        const idMap = {};
        const fresh = [];
        const earlier = [];
        for (const u of b.users) {
            const hit = fpToId.get(u.fp);
            if (hit) {
                idMap[u.id] = hit.id;
                /* 老记录可能创建更早：保留更早的 created，否则统计页会把它当成新用户 */
                if ((u.created || now) < (hit.created || now)) {
                    earlier.push(db.prepare('UPDATE users SET created = ? WHERE id = ?')
                        .bind(u.created || now, hit.id));
                }
            } else { idMap[u.id] = u.id; fresh.push(u); }
        }
        if (earlier.length) {
            for (const part of chunk(earlier, 40)) await db.batch(part);
        }
        out.users = await run(fresh, u => db.prepare(
            'INSERT OR IGNORE INTO users (id, fp, created, updated, conf, ua, screen, dpr, lang, tz, ip, country, city) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
        ).bind(u.id, u.fp, u.created || now, u.updated || u.created || now,
            u.conf == null ? null : Number(u.conf), u.ua || '', u.screen || '',
            u.dpr == null ? null : Number(u.dpr), u.lang || '', u.tz || '',
            u.ip || '', u.country || '', u.city || ''));
        out.usersMerged = b.users.length - fresh.length;

        if (Array.isArray(b.visits)) out.visits = await run(b.visits, v => db.prepare(
            'INSERT OR IGNORE INTO visits (id, user_id, ts, day, page, path, title, ref) VALUES (?,?,?,?,?,?,?,?)'
        ).bind(v.id, idMap[v.user_id] || v.user_id, v.ts || now, v.day || dayOf(v.ts || now),
            v.page || '', v.path || '', v.title || '', v.ref || ''));
    } else if (Array.isArray(b.visits)) {
        out.visits = await run(b.visits, v => db.prepare(
            'INSERT OR IGNORE INTO visits (id, user_id, ts, day, page, path, title, ref) VALUES (?,?,?,?,?,?,?,?)'
        ).bind(v.id, v.user_id, v.ts || now, v.day || dayOf(v.ts || now),
            v.page || '', v.path || '', v.title || '', v.ref || ''));
    }

    if (Array.isArray(b.markerTypes)) out.markerTypes = await run(b.markerTypes, t => db.prepare(
        'INSERT OR IGNORE INTO marker_types (id, name, color, sort, created) VALUES (?,?,?,?,?)'
    ).bind(t.id, t.name || '', t.color || '', Number(t.sort || 0), t.created || now));

    if (Array.isArray(b.markerPoints)) out.markerPoints = await run(b.markerPoints, p => db.prepare(
        'INSERT OR REPLACE INTO marker_points (id, type_id, lng, lat, props, created, updated) VALUES (?,?,?,?,?,?,?)'
    ).bind(p.id, p.type_id, Number(p.lng), Number(p.lat), JSON.stringify(p.props || {}),
        p.created || now, p.updated || now));

    if (Array.isArray(b.feedback)) out.feedback = await run(b.feedback, f => db.prepare(
        'INSERT OR IGNORE INTO feedback (id, type, content, contact, source, created_at) VALUES (?,?,?,?,?,?)'
    ).bind(f.id, f.type || '', f.content || '', f.contact || '', f.source || '', f.created_at || now));

    return json({ ok: true, imported: out }, 200, cors);
}
