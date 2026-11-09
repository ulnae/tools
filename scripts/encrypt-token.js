#!/usr/bin/env node
/* ============================================================
   encrypt-token.js — GitHub Token 加密工具
   把明文 token 加密为 github.js 中使用的 TOKEN_CIPHER 格式。

   算法与 utils/github.js 的 decrypt() 完全对称：
     base64( salt[16字节] + iv[12字节] + AES-GCM密文 )
     密钥派生：PBKDF2-SHA256，100000 次迭代，256 位

   用法：
     node encrypt-token.js                          # 交互式输入
     node encrypt-token.js <token>                  # 指定 token，密码默认 ulnae
     node encrypt-token.js <token> <password>       # 同时指定 token 与密码
   ============================================================ */
'use strict';

const readline = require('readline');

/* ---------- Web Crypto（兼容 Node 15+：旧版本无全局 crypto，需显式引入） ---------- */
const crypto = require('crypto').webcrypto;
if (!crypto || !crypto.subtle) {
    console.error('当前 Node 版本过低，缺少 Web Crypto 支持，请升级到 Node 15 及以上。');
    process.exit(1);
}

/* ---------- 交互式输入（同步嵌套回调，兼容管道输入） ---------- */
function makeRl() {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
    });
}

function promptAll(needToken, needPass, callback) {
    const rl = makeRl();
    let token = '', pass = '';

    // 问题按需串联，且每个后续问题在回调内同步注册（不能用 promise/await 串联，
    // 否则管道输入模式下第二个 readline.question 不会触发）
    const steps = [];
    if (needToken) {
        steps.push((next) => {
            const orig = rl._writeToOutput;
            if (typeof orig === 'function') {
                rl._writeToOutput = function (s) {
                    if (s.includes('请输入 GitHub Token: ')) orig.call(this, s);
                };
            }
            rl.question('请输入 GitHub Token: ', (ans) => {
                rl._writeToOutput = orig;
                token = ans.trim();
                next();
            });
        });
    }
    if (needPass) {
        steps.push((next) => {
            rl.question('请输入加密密码 (回车默认 ulnae): ', (ans) => {
                pass = ans.trim();
                next();
            });
        });
    }

    (function run(i) {
        if (i >= steps.length) {
            rl.close();
            callback(token, pass);
            return;
        }
        steps[i](() => run(i + 1));
    })(0);
}

/* ---------- 加密（与 github.js decrypt 对称） ---------- */
async function encrypt(plainText, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
        'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
    );
    const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
        baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
    );
    const encrypted = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plainText))
    );

    // 组装 salt + iv + cipher，再 base64
    const out = new Uint8Array(salt.length + iv.length + encrypted.length);
    out.set(salt, 0);
    out.set(iv, salt.length);
    out.set(encrypted, salt.length + iv.length);
    return Buffer.from(out).toString('base64');
}

/* ---------- 解密验证（复用 github.js 逻辑，确保可回解） ---------- */
async function decrypt(cipherText, password) {
    const data = new Uint8Array(Buffer.from(cipherText, 'base64'));
    const salt = data.subarray(0, 16);
    const iv = data.subarray(16, 28);
    const encrypted = data.subarray(28);
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
        'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
    );
    const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
        baseKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
    );
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
    return new TextDecoder().decode(decrypted);
}

/* ---------- 输出（走 console 以兼容 Windows 控制台编码；退出前稍等以确保管道输出刷完） ---------- */
const print = (s) => console.log(s);
const eprint = (s) => console.error(s);
const flushExit = (code) => setTimeout(() => process.exit(code), 150);

/* ---------- 主流程 ---------- */
(async () => {
    const [tokenArg, passArg] = process.argv.slice(2);
    let token = tokenArg || '';
    let pass = passArg || '';

    if (!token || !pass) {
        // 显式传了空密码参数时，直接用默认密码，不进入交互
        if (passArg !== undefined && !pass) {
            pass = 'ulnae';
        }
    }
    if (!token || !pass) {
        await new Promise((done) => {
            promptAll(!token, !pass, (t, p) => {
                if (t) token = t;
                if (p) pass = p;
                done();
            });
        });
        pass = pass || 'ulnae';
    }

    if (!token) {
        eprint('Token 不能为空');
        flushExit(1);
        return;
    }

    try {
        const cipher = await encrypt(token, pass);
        print('');
        print('[OK] 加密成功！');
        print('');
        print("TOKEN_CIPHER = '" + cipher + "',");
        print('');
        print('请将上面整行替换 utils/github.js 中的 TOKEN_CIPHER 值。');
        print('');

        // 回解验证
        const roundtrip = await decrypt(cipher, pass);
        if (roundtrip === token) {
            print('[OK] 回解验证通过：密文可用 TOKEN_PASS 正确解密。');
        } else {
            eprint('[FAIL] 回解验证失败，请检查脚本！');
            flushExit(1);
            return;
        }
    } catch (e) {
        eprint('[FAIL] 加密失败：' + e.message);
        flushExit(1);
        return;
    }
    flushExit(0);
})();
