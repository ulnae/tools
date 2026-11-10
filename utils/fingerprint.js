/**
 * fingerprint.js — 浏览器指纹 + 云端访问统计（FingerprintJS v4 + GitHub 仓库存储）
 *
 * 引入方式（绝对地址，任意目录层级通用）：
 *   <script src="https://ulnae.github.io/tools/utils/tracker-config.js"></script>
 *   <script src="https://ulnae.github.io/tools/utils/fp.min.js"></script>
 *   <script src="https://ulnae.github.io/tools/utils/fingerprint.js"></script>
 *
 * 数据全部存放在仓库（默认 stats 分支），**不使用 localStorage**：
 *   data/users.json        用户索引
 *                          { updated, users: [ { id, fp, created, ua, screen, lang, tz } ] }
 *   data/visits/{id}.json  单个用户的访问数据
 *                          { id, fp, created, updated, total, pages, days, visits: [...] }
 *
 * 执行流程：
 *   1. 计算浏览器指纹并输出到控制台；
 *   2. 读取 users.json，用指纹匹配已有用户；
 *   3. 匹配不到 → 新建用户（生成 id）并写入 users.json；
 *   4. 把本次访问（页面 / 时间 / 来源等）追加到该用户自己的 {id}.json 里。
 *
 * 失败即放弃：不回写本地、不排队补传（按需求不做补偿），只在控制台告警。
 *
 * 对外 API（window.VisitTracker）：
 *   await VisitTracker.ready                  // 初始化完成（含自动上报）
 *   await VisitTracker.track()                // 手动记录一次访问
 *   await VisitTracker.getUsers()             // 用户索引数组
 *   await VisitTracker.getUser(id)            // 单个用户的完整数据
 *   await VisitTracker.removeVisit(id, vid)   // 删除该用户的一条访问
 *   await VisitTracker.removeUser(id)         // 删除用户（索引 + 数据文件）
 *   await VisitTracker.clearAll()             // 清空全部用户与数据
 *
 * 依赖库：FingerprintJS v4.6.2（BSL 1.1，Change Date 后转 MIT）
 */
(function () {
    'use strict';

    /* 本脚本自身地址：用于按同目录加载 github.js（页面在任意层级都能正确定位） */
    const SELF_SRC = (document.currentScript && document.currentScript.src) || '';
    const utilUrl = file => SELF_SRC ? SELF_SRC.replace(/[^/]*$/, '') + file : './utils/' + file;

    /* ==================== 配置 ==================== */
    const CFG = {
        disableAutoTrack: false,          // true = 不自动记录本次访问（统计页等后台页面使用）

        ghBranch: 'stats',                // 数据所在分支（避开 master，写入不触发 Pages 构建）
        usersPath: 'data/users.json',     // 用户索引
        visitsDir: 'data/visits',         // 单用户数据目录，文件名即用户 id
        ghModule: '',                     // github.js 地址，留空 = 自动按同目录加载

        maxVisits: 200,                   // 单个用户保留的访问明细条数（total/pages/days 仍累计全部）
        keepDays: 90,                     // 按天统计的保留天数
        debug: true
    };

    /* 页面可在引入本脚本前覆盖配置，见 utils/tracker-config.js */
    if (window.VISIT_TRACKER_CONFIG && typeof window.VISIT_TRACKER_CONFIG === 'object') {
        Object.assign(CFG, window.VISIT_TRACKER_CONFIG);
    }

    const LIB_READY_EVENT = 'fingerprintjs-ready';
    const TRACKED_EVENT = 'visit-tracked';
    const log = (...a) => { if (CFG.debug) console.log('[VisitTracker]', ...a); };
    const warn = (...a) => console.warn('[VisitTracker]', ...a);

    /* ==================== 小工具 ==================== */
    const pad = n => String(n).padStart(2, '0');
    const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const rnd = (n = 5) => Math.random().toString(36).slice(2, 2 + n);

    /* 用户 id：u + 时间戳36进制 + 随机串，直接当文件名用 */
    const newUserId = () => 'u' + Date.now().toString(36) + rnd(4);
    const newVisitId = () => 'v' + Date.now().toString(36) + rnd(5);

    const userFilePath = id => `${CFG.visitsDir}/${id}.json`;

    /* ==================== 1. 指纹 ==================== */
    async function getBrowserFingerprint() {
        if (typeof window.FingerprintJS === 'undefined') {
            throw new Error('FingerprintJS 未加载，请先引入 utils/fp.min.js');
        }
        const fp = await window.FingerprintJS.load({ monitor: false });
        return fp.get();
    }
    window.getBrowserFingerprint = getBrowserFingerprint;

    /* 指纹只计算一次，多处复用 */
    let fpPromise = null;
    function fpCached() {
        if (!fpPromise) {
            fpPromise = getBrowserFingerprint().catch(err => {
                fpPromise = null;              // 失败允许下次重试
                throw err;
            });
        }
        return fpPromise;
    }

    /* ==================== 2. GitHub 存储 ==================== */
    let ghPromise = null;
    function loadGithub() {
        if (window.GitHub) return Promise.resolve(window.GitHub);
        if (ghPromise) return ghPromise;
        ghPromise = new Promise(resolve => {
            const s = document.createElement('script');
            let settled = false;
            const done = v => { if (!settled) { settled = true; resolve(v); } };
            s.src = CFG.ghModule || utilUrl('github.js');
            s.async = true;
            s.onload = () => done(window.GitHub || null);
            s.onerror = () => { warn('github.js 加载失败，无法读写云端数据'); done(null); };
            setTimeout(() => done(window.GitHub || null), 8000);
            document.head.appendChild(s);
        });
        return ghPromise;
    }

    async function requireGithub() {
        const gh = await loadGithub();
        if (!gh) throw new Error('github.js 不可用');
        await gh.init();
        return gh;
    }

    /* ==================== 3. 数据规范化 ==================== */
    function normalizeUsers(c) {
        const list = (c && Array.isArray(c.users)) ? c.users : (Array.isArray(c) ? c : []);
        return {
            updated: (c && typeof c.updated === 'number') ? c.updated : 0,
            users: list.filter(u => u && u.id)
        };
    }

    function normalizeUserFile(c, id, fp) {
        const f = (c && typeof c === 'object' && !Array.isArray(c)) ? c : {};
        return {
            id: id || f.id || '',
            fp: f.fp || fp || '',
            created: Number(f.created) || Date.now(),
            updated: Number(f.updated) || 0,
            total: Number(f.total) || 0,
            pages: (f.pages && typeof f.pages === 'object') ? f.pages : {},
            days: (f.days && typeof f.days === 'object') ? f.days : {},
            visits: Array.isArray(f.visits) ? f.visits : []
        };
    }

    /* 新用户首次访问时记录的环境信息（不随每次访问重复存） */
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

    /* ==================== 4. 用户索引 ==================== */
    async function readUsers() {
        const gh = await requireGithub();
        const { content } = await gh.getFile(CFG.usersPath, CFG.ghBranch);
        return normalizeUsers(content);
    }

    /**
     * 按指纹找用户，找不到就新建一条写进 users.json。
     * 并发首访时由 updateFile 内的二次校验兜底，不会建出重复用户。
     */
    async function ensureUser(fpId, conf) {
        const idx = await readUsers();
        const hit = idx.users.find(u => u.fp === fpId);
        if (hit) return hit;

        const gh = await requireGithub();
        let created = null;

        const res = await gh.updateFile(CFG.usersPath, latest => {
            const data = normalizeUsers(latest);
            if (data.users.some(u => u.fp === fpId)) return null;   // 其他标签页已创建
            created = Object.assign(
                { id: newUserId(), fp: fpId, created: Date.now(), conf: conf == null ? null : Math.round(conf * 1000) / 1000 },
                envInfo()
            );
            data.users.push(created);
            data.updated = Date.now();
            return data;
        }, `新增访客 ${fpId.slice(0, 8)}`, 4, CFG.ghBranch);

        const final = normalizeUsers(res.content).users.find(u => u.fp === fpId);
        if (final) {
            if (created && final.id === created.id) log('新用户已创建：' + final.id);
            return final;
        }
        if (created) { warn('用户索引写入未生效，仍按临时 id 记录'); return created; }
        throw new Error('用户索引写入失败');
    }

    /* ==================== 5. 单用户访问数据 ==================== */
    function trimDays(days) {
        const cutoff = dayKey(new Date(Date.now() - CFG.keepDays * 864e5));
        Object.keys(days).forEach(d => { if (d < cutoff) delete days[d]; });
    }

    async function appendVisit(user, visit) {
        const gh = await requireGithub();
        const path = userFilePath(user.id);

        const res = await gh.updateFile(path, latest => {
            const f = normalizeUserFile(latest, user.id, user.fp);
            if (f.visits.some(v => v.id === visit.id)) return null;   // 重复提交，跳过

            f.visits.unshift(visit);
            f.visits = f.visits.slice(0, CFG.maxVisits);
            f.total += 1;
            f.pages[visit.page] = (f.pages[visit.page] || 0) + 1;
            f.days[visit.day] = (f.days[visit.day] || 0) + 1;
            trimDays(f.days);
            f.updated = visit.ts;
            f.fp = f.fp || user.fp;
            return f;
        }, `访问记录 ${user.id} · ${visit.page}`, 4, CFG.ghBranch);

        return normalizeUserFile(res.content, user.id, user.fp);
    }

    /* ==================== 6. 对外 API ==================== */
    const VisitTracker = {
        /* 数据只存云端，恒为 'cloud' */
        get mode() { return 'cloud'; },

        async track(extra = {}) {
            let fp = null;
            try { fp = await fpCached(); }
            catch (err) { warn('指纹获取失败：' + (err && err.message)); }

            if (!fp || !fp.visitorId) {
                warn('缺少指纹，本次访问未上报');
                return null;
            }

            const user = await ensureUser(fp.visitorId, fp.confidence && fp.confidence.score);
            const visit = buildVisit(extra);
            await appendVisit(user, visit);

            document.dispatchEvent(new CustomEvent(TRACKED_EVENT, { detail: { user, visit } }));
            return { user, visit };
        },

        /* 用户索引（按创建时间倒序） */
        async getUsers() {
            const idx = await readUsers();
            return idx.users.slice().sort((a, b) => (b.created || 0) - (a.created || 0));
        },

        /* 单个用户的完整数据；文件不存在时返回 null */
        async getUser(id) {
            if (!id) return null;
            const gh = await requireGithub();
            const { content } = await gh.getFile(userFilePath(id), CFG.ghBranch);
            if (!content) return null;
            return normalizeUserFile(content, id);
        },

        /* 删除某用户的一条访问记录（同步修正 total / pages / days） */
        async removeVisit(userId, visitId) {
            if (!userId || !visitId) return false;
            const gh = await requireGithub();

            const res = await gh.updateFile(userFilePath(userId), latest => {
                const f = normalizeUserFile(latest, userId);
                const target = f.visits.find(v => v.id === visitId);
                if (!target) return null;

                f.visits = f.visits.filter(v => v.id !== visitId);
                f.total = Math.max(0, f.total - 1);

                if (target.page && f.pages[target.page]) {
                    f.pages[target.page] -= 1;
                    if (f.pages[target.page] <= 0) delete f.pages[target.page];
                }
                if (target.day && f.days[target.day]) {
                    f.days[target.day] -= 1;
                    if (!f.days[target.day]) delete f.days[target.day];
                }
                return f;
            }, `删除访问记录 ${userId} · ${visitId}`, 4, CFG.ghBranch);

            return !res.skipped;
        },

        /* 删除用户：索引条目 + 该用户的数据文件 */
        async removeUser(id) {
            if (!id) return false;
            const gh = await requireGithub();

            const res = await gh.updateFile(CFG.usersPath, latest => {
                const data = normalizeUsers(latest);
                const next = data.users.filter(u => u.id !== id);
                if (next.length === data.users.length) return null;
                data.users = next;
                data.updated = Date.now();
                return data;
            }, `删除访客 ${id}`, 4, CFG.ghBranch);

            try {
                await gh.deleteFile(userFilePath(id), `删除访客数据 ${id}`, CFG.ghBranch);
            } catch (err) {
                warn('用户数据文件删除失败：' + err.message);
            }
            return !res.skipped;
        },

        /* 清空全部用户与访问数据 */
        async clearAll() {
            const gh = await requireGithub();
            const users = (await readUsers()).users;

            await gh.updateFile(CFG.usersPath, latest => {
                const data = normalizeUsers(latest);
                if (!data.users.length) return null;
                data.users = [];
                data.updated = Date.now();
                return data;
            }, '清空访客索引', 4, CFG.ghBranch);

            for (const u of users) {
                try {
                    await gh.deleteFile(userFilePath(u.id), `删除访客数据 ${u.id}`, CFG.ghBranch);
                } catch (err) {
                    warn(`删除 ${u.id} 失败：` + err.message);
                }
            }
            return users.length;
        }
    };
    window.VisitTracker = VisitTracker;

    /* ==================== 7. 自动执行 ==================== */
    VisitTracker.ready = (async () => {
        /* 统计/后台页面可置 disableAutoTrack: true，避免自身访问被计入 */
        if (CFG.disableAutoTrack) {
            log('disableAutoTrack 已开启，跳过自动记录');
            return null;
        }

        let fp = null;
        try {
            fp = await fpCached();
            console.groupCollapsed(
                '%c浏览器指纹 (FingerprintJS v' + fp.version + ')',
                'color:#007AFF;font-weight:bold'
            );
            console.log('visitorId:', fp.visitorId);
            console.log('置信度:', fp.confidence && fp.confidence.score);
            console.log('组件明细:', fp.components);
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
            console.groupCollapsed('%c本次访问已写入云端', 'color:#34C759;font-weight:bold');
            console.log('用户 ID:', user.id);
            console.log('指纹:', user.fp);
            console.log('页面:', visit.page);
            console.log('时间:', new Date(visit.ts).toLocaleString('zh-CN'));
            console.log('数据文件:', userFilePath(user.id));
            console.groupEnd();
            return result;
        } catch (err) {
            console.warn('[VisitTracker] 上报失败（不做本地补偿）:', err && err.message);
            return null;
        }
    })();
})();
