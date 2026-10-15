/* ============================================================
   GitHub 共享模块：配置 / 加解密 / Contents API
   依赖：无（原生 fetch + Web Crypto）
   用法：
     await GitHub.init();                                    // 解密 token
     const { content, sha } = await GitHub.getFile(path);
     await GitHub.updateFile(path, mutate, message);         // 安全写
     await GitHub.deleteFile(path, message);                 // 删除文件
   ============================================================ */
window.GitHub = (function () {
    'use strict';

    /* ---------- 共享配置 ---------- */
    const CONFIG = {
        OWNER: 'ulnae',
        REPO: 'tools',
        BRANCH: 'master',

        DATA_DIR: 'data',
        TYPES_FILE: 'data/types.json',
        FEEDBACK_FILE: 'data/feedback.json',

        TOKEN: '',   // 运行时由 init() 填充
        TOKEN_CIPHER: 'pN0DLAO2zEwTMKZlJZw+6zd4GAXI0t3mCX/iAqiGWY6ddaYNpX4u6LdZ7eeflYz7RaSCt6hCUYSPbhbejCY7lVChS9u3YaVWhiU38RWdMQf0iRo4UwUZ5kmnzZXBiZlDVIgWBVNPoxeFveABj02UVh8IFBBix/Bz+AOD9DIdlN8Jbh3s3olHlPs=',
        TOKEN_PASS: 'ulnae'
    };

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    /* ============================================================
       AES-GCM + PBKDF2 解密
       ============================================================ */
    async function decrypt(cipherText, password) {
        const binary = atob(cipherText.trim());
        const data = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
        const salt = data.subarray(0, 16);
        const iv = data.subarray(16, 28);
        const encrypted = data.subarray(28);
        const enc = new TextEncoder();
        const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
        const key = await crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
            baseKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
        );
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
        return new TextDecoder().decode(decrypted);
    }

    /* ============================================================
       初始化：解密 token（可重复调用，幂等）
       ============================================================ */
    async function init() {
        if (CONFIG.TOKEN) return CONFIG.TOKEN;
        CONFIG.TOKEN = await decrypt(CONFIG.TOKEN_CIPHER, CONFIG.TOKEN_PASS);
        return CONFIG.TOKEN;
    }

    /* ============================================================
       GitHub Contents API
       ============================================================ */
    async function api(path, options = {}) {
        const url = `https://api.github.com/repos/${CONFIG.OWNER}/${CONFIG.REPO}/contents/${path}`;
        const res = await fetch(url, {
            ...options,
            headers: {
                'Accept': 'application/vnd.github+json',
                'Authorization': `Bearer ${CONFIG.TOKEN}`,
                'Content-Type': 'application/json',
                ...(options.headers || {})
            }
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || `GitHub API 错误 (${res.status})`);
        }
        const text = await res.text();
        return text ? JSON.parse(text) : {};
    }

    /** 读取 JSON：永远返回 { content, sha }，不存在/解析失败时 content 为 null */
    async function getFile(path) {
        try {
            const data = await api(path);
            const raw = atob((data.content || '').replace(/\s/g, ''));
            if (!raw) return { content: null, sha: data.sha };
            const text = decodeURIComponent(escape(raw));
            try {
                return { content: JSON.parse(text), sha: data.sha };
            } catch (e) {
                console.warn(`文件 ${path} 不是合法 JSON，按空数据处理`);
                return { content: null, sha: data.sha };
            }
        } catch (e) {
            if (/not found|404/i.test(e.message)) return { content: null, sha: null };
            throw e;
        }
    }

    async function putFile(path, obj, message, sha) {
        const content = btoa(unescape(encodeURIComponent(JSON.stringify(obj, null, 2))));
        const body = { message, content, branch: CONFIG.BRANCH };
        if (sha) body.sha = sha;
        return api(path, { method: 'PUT', body: JSON.stringify(body) });
    }

    /** 删除文件；文件不存在时返回 false（不抛错） */
    async function deleteFile(path, message) {
        let sha = null;
        try {
            const data = await api(path);
            sha = data.sha;
        } catch (e) {
            if (/not found|404/i.test(e.message)) return false;
            throw e;
        }
        await api(path, {
            method: 'DELETE',
            body: JSON.stringify({ message, sha, branch: CONFIG.BRANCH })
        });
        return true;
    }

    /**
     * 安全写：每次提交前重新拉取最新内容与 sha，冲突自动重试。
     * mutate(latestContent, latestSha) 返回：
     *   - 新对象  → 提交写入
     *   - null/undefined → 视为无需修改，跳过（返回 skipped: true）
     */
    async function updateFile(path, mutate, message, maxAttempts = 4) {
        let lastErr = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const { content, sha } = await getFile(path);
            const next = await mutate(content, sha);
            if (next === null || next === undefined) {
                return { content, sha, skipped: true };
            }
            try {
                const res = await putFile(path, next, message, sha);
                return { content: next, sha: res.content.sha, skipped: false };
            } catch (err) {
                lastErr = err;
                console.warn(`写入 ${path} 第 ${attempt} 次失败：${err.message}`);
                if (attempt < maxAttempts) await sleep(350 * attempt);
            }
        }
        throw lastErr || new Error('保存失败');
    }

    /* ---------- 对外接口 ---------- */
    return { CONFIG, init, decrypt, getFile, putFile, deleteFile, updateFile };
})();