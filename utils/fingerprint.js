/**
 * fingerprint.js — 浏览器指纹 + 访问记录（FingerprintJS v4 + GitHub 共享存储）
 *
 * 引入方式（绝对地址，任意目录层级通用）：
 *   <script src="https://ulnae.github.io/tools/utils/tracker-config.js"></script>
 *   <script src="https://ulnae.github.io/tools/utils/fp.min.js"></script>
 *   <script src="https://ulnae.github.io/tools/utils/fingerprint.js"></script>
 *
 * 引入后自动完成：
 *   1. 获取浏览器指纹，输出到控制台；
 *   2. 记录本次访问（时间 / 指纹 / 页面 / UA 等）到本地 localStorage；
 *   3. 启用 GitHub 共享存储时，把记录追加到仓库 stats 分支的 data/visits.json。
 *
 * 对外 API（window.VisitTracker）：
 *   await VisitTracker.ready                 // 初始化完成的 Promise
 *   await VisitTracker.track({ extra: 1 })   // 手动补记一次访问
 *   await VisitTracker.getStats()            // { total, pages, days, fps, updated }
 *   await VisitTracker.getVisits(50)         // 最近 N 条访问明细
 *   VisitTracker.mode                        // 'github' | 'local'
 *   await VisitTracker.sync()                // 把本地未同步记录补传云端
 *   VisitTracker.clearLocal()                // 清空本地记录（不动云端）
 *
 * 两种存储模式（按优先级自动选择）：
 *   1. github：CFG.github = true 时，把明细写入 GitHub 仓库的独立分支
 *      （默认 data/visits.json @ stats 分支），免注册、免登录、写入不触发 Pages 构建；
 *   2. local ：GitHub 不可用时只写 localStorage，功能不中断，恢复后 sync() 补传。
 *
 * 设计要点：
 *   - 本地优先：任何环境下都能记录，离线/请求失败不影响主流程；
 *   - 只保存访客标识的短哈希，不把原始指纹写进公开仓库；
 *   - 明细用「读-改-写 + sha 冲突重试」保证并发追加不丢数据。
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

        /* GitHub 共享存储：用仓库的独立分支存放访问明细。
           零成本、无需注册新服务，写入不触发 Pages 构建（不在 master 上）。 */
        github: false,
        ghBranch: 'stats',                // 数据所在分支
        ghPath: 'data/visits.json',       // 数据文件路径
        ghModule: '',                     // github.js 地址，留空 = 自动按同目录加载
        maxCloudVisits: 300,              // 云端明细上限

        localVisits: 'tb:local:visits',   // 本地：明细镜像（含未同步记录）
        maxLocalVisits: 300,              // 本地明细上限
        keepDays: 90,                     // 统计保留天数
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
    const rid = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

    function readJSON(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (_) { return fallback; }
    }
    function writeJSON(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); return true; }
        catch (_) { return false; }
    }

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

    /* ==================== 2. GitHub 共享存储 ==================== */
    const hasGithub = () => !!CFG.github;

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
            s.onerror = () => { warn('github.js 加载失败，回退本地'); done(null); };
            setTimeout(() => done(window.GitHub || null), 8000);
            document.head.appendChild(s);
        });
        return ghPromise;
    }

    /* 访客标识脱敏：仓库是公开的，只存短哈希，不存原始指纹 */
    function vidHash(v) {
        if (!v) return '';
        let h = 0x811c9dc5;
        for (let i = 0; i < v.length; i++) { h ^= v.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
        return 'h' + h.toString(16).padStart(8, '0');
    }

    async function ghRead() {
        const gh = await loadGithub();
        if (!gh) throw new Error('github.js 不可用');
        await gh.init();
        const { content } = await gh.getFile(CFG.ghPath, CFG.ghBranch);
        return content && Array.isArray(content.visits) ? content.visits : [];
    }

    async function ghSave(records) {
        if (!hasGithub() || !records.length) return false;
        try {
            const gh = await loadGithub();
            if (!gh) return false;
            await gh.init();
            const clean = records.map(r => Object.assign({}, r, { vid: vidHash(r.vid), cloud: true }));
            await gh.updateFile(CFG.ghPath, latest => {
                const list = latest && Array.isArray(latest.visits) ? latest.visits : [];
                const ids = new Set(clean.map(r => r.id));
                return {
                    visits: clean.concat(list.filter(r => !ids.has(r.id))).slice(0, CFG.maxCloudVisits),
                    updated: Date.now()
                };
            }, `chore(stats): 记录 ${clean.length} 次访问`, 4, CFG.ghBranch);
            return true;
        } catch (err) {
            warn('GitHub 写入失败，回退本地：', err && err.message);
            return false;
        }
    }

    /* ==================== 3. 访问记录构造 ==================== */
    function buildRecord(extra = {}) {
        const nav = window.navigator || {};
        const loc = window.location;
        const page = (loc.pathname.split('/').pop() || 'index.html');
        return Object.assign({
            id: rid(),
            ts: Date.now(),
            iso: new Date().toISOString(),
            day: dayKey(),
            page,
            path: loc.pathname,
            title: document.title || '',
            referrer: (() => { try { return document.referrer ? new URL(document.referrer).host : ''; } catch (_) { return ''; } })(),
            vid: '',
            fpConf: null,
            lang: nav.language || '',
            tz: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return ''; } })(),
            screen: (() => { const s = window.screen || {}; return `${s.width || 0}x${s.height || 0}`; })(),
            dpr: window.devicePixelRatio || 1,
            ua: nav.userAgent || '',
            cloud: false
        }, extra);
    }

    /* ==================== 4. 统计聚合 ==================== */
    function bumpStats(stats, rec) {
        const s = stats && typeof stats === 'object' ? stats : {};
        s.total = (s.total || 0) + 1;
        s.pages = s.pages || {};
        s.days = s.days || {};
        s.fps = s.fps || {};

        const p = s.pages[rec.page] || { n: 0, last: 0 };
        p.n += 1; p.last = rec.ts;
        s.pages[rec.page] = p;

        s.days[rec.day] = (s.days[rec.day] || 0) + 1;

        if (rec.vid) {
            const f = s.fps[rec.vid] || { n: 0, first: rec.ts, last: rec.ts };
            f.n += 1; f.last = rec.ts;
            s.fps[rec.vid] = f;
        }

        // 只保留最近 keepDays 天，避免统计键无限增长
        const cutoff = dayKey(new Date(Date.now() - CFG.keepDays * 864e5));
        Object.keys(s.days).forEach(d => { if (d < cutoff) delete s.days[d]; });

        s.updated = rec.ts;
        return s;
    }

    /* ==================== 5. 本地存取 ==================== */
    function readLocalVisits() { return readJSON(CFG.localVisits, []); }
    function pushLocalVisit(rec) {
        const list = readLocalVisits();
        list.unshift(rec);
        writeJSON(CFG.localVisits, list.slice(0, CFG.maxLocalVisits));
    }
    function markLocalSynced(ids) {
        const set = new Set(ids);
        const list = readLocalVisits().map(r => (set.has(r.id) ? Object.assign({}, r, { cloud: true }) : r));
        writeJSON(CFG.localVisits, list);
    }

    /* ==================== 6. 云端写入 ==================== */
    /* 免注册通道：写入 GitHub 仓库独立分支 */
    async function githubSaveVisit(rec) {
        return hasGithub() ? ghSave([rec]) : false;
    }

    /* ==================== 7. 对外 API ==================== */
    const VisitTracker = {
        /* 当前存储模式：'github' | 'local' */
        get mode() {
            return hasGithub() ? 'github' : 'local';
        },

        async track(extra = {}) {
            /* 先拿指纹，再建记录，保证本地与云端记录字段一致 */
            let fp = null;
            try { fp = await fpCached(); }
            catch (err) { warn('指纹获取失败，记录将不含 vid：', err && err.message); }

            const rec = buildRecord(Object.assign({
                vid: fp ? fp.visitorId : '',
                fpConf: fp && fp.confidence ? fp.confidence.score : null
            }, extra));

            pushLocalVisit(rec);
            rec.cloud = await githubSaveVisit(rec);
            if (rec.cloud) markLocalSynced([rec.id]);

            document.dispatchEvent(new CustomEvent(TRACKED_EVENT, { detail: rec }));
            return rec;
        },

        async getVisits(limit = 50) {
            if (hasGithub()) {
                try {
                    const list = await ghRead();
                    return list.slice(0, limit);
                } catch (err) { warn('GitHub 读取失败，回退本地：', err && err.message); }
            }
            return readLocalVisits().slice(0, limit);
        },

        async getStats() {
            if (hasGithub()) {
                try {
                    const list = await ghRead();
                    const s = list.reduce((acc, r) => bumpStats(acc, r), {});
                    if (!s.updated) s.updated = Date.now();
                    return s;
                } catch (err) { warn('GitHub 统计读取失败，回退本地：', err && err.message); }
            }
            // 本地兜底：用本地明细现算
            return readLocalVisits().reduce((acc, r) => bumpStats(acc, r), {});
        },

        async sync() {
            if (!hasGithub()) return 0;
            const pending = readLocalVisits().filter(r => !r.cloud);
            if (!pending.length) return 0;

            /* 一次提交合并全部待同步记录，避免每条一次 commit */
            const done = await ghSave(pending);
            if (done) markLocalSynced(pending.map(r => r.id));
            log(`GitHub 补传 ${done ? pending.length : 0}/${pending.length} 条记录`);
            return done ? pending.length : 0;
        },

        clearLocal() { writeJSON(CFG.localVisits, []); }
    };
    window.VisitTracker = VisitTracker;

    /* ==================== 8. 自动执行 ==================== */
    VisitTracker.ready = (async () => {
        /* 统计/后台页面可置 disableAutoTrack: true，避免自身访问被计入 */
        if (CFG.disableAutoTrack) {
            log('disableAutoTrack 已开启，跳过自动记录');
            return null;
        }

        /* 1. 先算指纹；失败也继续记录（只是缺 vid） */
        let fpResult = null;
        try {
            fpResult = await fpCached();

            console.groupCollapsed(
                '%c浏览器指纹 (FingerprintJS v' + fpResult.version + ')',
                'color:#007AFF;font-weight:bold'
            );
            console.log('visitorId:', fpResult.visitorId);
            console.log('置信度:', fpResult.confidence && fpResult.confidence.score);
            console.log('组件明细:', fpResult.components);
            try { console.table(Object.keys(fpResult.components)); } catch (_) { /* ignore */ }
            console.groupEnd();

            window.dispatchEvent(new CustomEvent(LIB_READY_EVENT, { detail: fpResult }));
        } catch (err) {
            console.error('[fingerprint.js] 获取指纹失败:', err && err.message);
        }

        /* 2. 立刻记录本次访问：本地先落库，再尝试远程（网络慢/挂掉都不会漏记） */
        const rec = await VisitTracker.track();

        /* 3. 补传历史待同步记录，放到记录之后且不阻塞页面 */
        if (hasGithub()) VisitTracker.sync().catch(() => {});

        console.groupCollapsed('%c本次访问已记录', 'color:#34C759;font-weight:bold');
        console.log('时间:', rec.iso);
        console.log('页面:', rec.page);
        console.log('指纹:', rec.vid || '(未获取)');
        console.log('存储:', rec.cloud ? 'GitHub 共享数据 + 本地' : '仅本地（云端未生效）');
        console.groupEnd();

        return rec;
    })();
})();
