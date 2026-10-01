const encoder = new TextEncoder();
const loginBase = "https://copilot.tencent.com";
const clientUA = "CLI/2.63.2 CodeBuddy/2.63.2";
const loginOrigin = "https://www.codebuddy.cn";
const maxAccounts = 10;

class ServiceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function headersFor(domain = "") {
  const global = /(^|\.)workbuddy\.ai$/i.test(domain);
  const origin = global ? "https://www.workbuddy.ai" : loginOrigin;
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: origin,
    Referer: `${origin}/`,
    "User-Agent": clientUA,
  };
}

function chatBase(account) {
  return /(^|\.)workbuddy\.ai$/i.test(account.domain || "")
    ? "https://www.workbuddy.ai"
    : loginBase;
}

function billingBase(account) {
  return /(^|\.)workbuddy\.ai$/i.test(account.domain || "")
    ? "https://www.workbuddy.ai"
    : loginOrigin;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function constantTimeEqual(a, b) {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    mismatch |= (left[i] || 0) ^ (right[i] || 0);
  }
  return mismatch === 0;
}

function isAuthorized(request, env) {
  const expected = env.APP_PASSWORD || "";
  const match = request.headers.get("Authorization")?.match(/^Bearer (.+)$/i);
  return expected.length > 0 && constantTimeEqual(match?.[1] || "", expected);
}

function requireDatabase(env) {
  if (!env.DB) throw new ServiceError("DATABASE");
  return env.DB;
}

async function readBody(request) {
  const raw = await request.text();
  if (raw.length > 4096) throw new ServiceError("BAD_REQUEST");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new ServiceError("BAD_REQUEST");
  }
}

function errorCodeFor(status, message = "") {
  if (status === 401 || /12153|unauthorized|session_dead/i.test(message)) return "AUTH";
  if (status >= 500) return "UPSTREAM";
  if (status >= 400) return "UPSTREAM";
  return "BUSINESS";
}

async function fetchWithRetry(url, init) {
  const delays = [500, 1500];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(15000),
      });
      if (response.status >= 500 && attempt < delays.length) {
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        continue;
      }
      return response;
    } catch (error) {
      if (attempt === delays.length) throw new ServiceError("UPSTREAM");
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
  throw new ServiceError("UPSTREAM");
}

async function upstreamJSON(url, init, { allowBusinessError = false } = {}) {
  const response = await fetchWithRetry(url, init);
  const setCookies = response.headers.getSetCookie?.() || [];
  let body;
  try {
    body = await response.json();
  } catch {
    throw new ServiceError("UPSTREAM");
  }
  if (!response.ok) throw new ServiceError(errorCodeFor(response.status));
  if (!body || typeof body !== "object") throw new ServiceError("UPSTREAM");

  const code = Number(body.code ?? 0);
  if (!Number.isFinite(code)) throw new ServiceError("UPSTREAM");
  const message = typeof body.msg === "string" ? body.msg : "";
  if (code !== 0 && !allowBusinessError) {
    throw new ServiceError(errorCodeFor(response.status, message));
  }
  return { code, message, data: body.data, setCookies };
}

function mergeCookies(current, updates = []) {
  const cookies = new Map();
  for (const item of current.split(";")) {
    const separator = item.indexOf("=");
    if (separator > 0) cookies.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim());
  }
  for (const header of updates) {
    const pair = header.split(";", 1)[0].trim();
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue;
    const maxAge = header.match(/;\s*max-age\s*=\s*(-?\d+)/i);
    if (maxAge && Number(maxAge[1]) <= 0) cookies.delete(name);
    else cookies.set(name, pair.slice(separator + 1).trim());
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

function base64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function encryptionKey(env) {
  if (!env.DATA_ENCRYPTION_KEY) throw new ServiceError("ENCRYPTION");
  let raw;
  try {
    raw = fromBase64(env.DATA_ENCRYPTION_KEY);
  } catch {
    throw new ServiceError("ENCRYPTION");
  }
  if (raw.length !== 32) throw new ServiceError("ENCRYPTION");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptAccount(account, env) {
  const key = await encryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cleartext = encoder.encode(JSON.stringify(account));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, cleartext);
  return `v1.${base64(iv)}.${base64(new Uint8Array(ciphertext))}`;
}

async function decryptAccount(encrypted, env) {
  const parts = encrypted.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new ServiceError("ENCRYPTION");
  try {
    const key = await encryptionKey(env);
    const cleartext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(parts[1]) },
      key,
      fromBase64(parts[2]),
    );
    return JSON.parse(new TextDecoder().decode(cleartext));
  } catch {
    throw new ServiceError("ENCRYPTION");
  }
}

async function saveAccount(accountId, account, env) {
  const db = requireDatabase(env);
  const encrypted = await encryptAccount(account, env);
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(`
    INSERT INTO accounts (account_id, encrypted_auth, connected_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET encrypted_auth = excluded.encrypted_auth, updated_at = excluded.updated_at
  `).bind(accountId, encrypted, now, now).run();
  await db.prepare(`
    INSERT OR IGNORE INTO account_state (account_id, lock_until) VALUES (?, 0)
  `).bind(accountId).run();
}

async function loadAccount(accountId, env) {
  const row = await requireDatabase(env)
    .prepare("SELECT encrypted_auth FROM accounts WHERE account_id = ?")
    .bind(accountId)
    .first();
  return row ? decryptAccount(row.encrypted_auth, env) : null;
}

async function accountIdForUID(uid, env) {
  const { results = [] } = await requireDatabase(env)
    .prepare("SELECT account_id, encrypted_auth FROM accounts")
    .all();
  for (const row of results) {
    const account = await decryptAccount(row.encrypted_auth, env);
    if (String(account.uid) === String(uid)) return row.account_id;
  }
  return null;
}

async function updateRunState(env, accountId, result, message, balance = null) {
  const now = Math.floor(Date.now() / 1000);
  await requireDatabase(env).prepare(`
    UPDATE account_state
    SET last_run_at = ?, last_result = ?, last_message = ?, last_balance = ?
    WHERE account_id = ?
  `).bind(now, result, message, balance, accountId).run();
}

async function readStatus(env) {
  const db = requireDatabase(env);
  const { results = [] } = await db.prepare(`
    SELECT a.account_id, a.encrypted_auth, a.connected_at,
      s.last_run_at, s.last_result, s.last_message, s.last_balance
    FROM accounts a LEFT JOIN account_state s ON s.account_id = a.account_id
    ORDER BY a.connected_at, a.account_id
  `).all();
  const accounts = await Promise.all(results.map(async (row) => {
    const account = await decryptAccount(row.encrypted_auth, env);
    return {
      id: row.account_id,
      nickname: account.nickname || "WorkBuddy",
      uidSuffix: String(account.uid || "").slice(-4),
      domain: account.domain || "CodeBuddy CN",
      connectedAt: row.connected_at,
      lastRunAt: row.last_run_at || null,
      result: row.last_result || null,
      message: row.last_message || null,
      balance: row.last_balance ?? null,
    };
  }));
  return { accounts, maxAccounts };
}

async function startLogin(env) {
  const db = requireDatabase(env);
  const result = await upstreamJSON(
    `${loginBase}/v2/plugin/auth/state?platform=CLI`,
    {
      method: "POST",
      headers: headersFor(),
      body: "{}",
    },
  );
  const state = result.data?.state;
  const authURL = result.data?.authUrl;
  if (typeof state !== "string" || !state || typeof authURL !== "string") {
    throw new ServiceError("UPSTREAM");
  }

  let parsedURL;
  try {
    parsedURL = new URL(authURL);
  } catch {
    throw new ServiceError("UPSTREAM");
  }
  const allowedHost = parsedURL.hostname === "copilot.tencent.com"
    || parsedURL.hostname === "codebuddy.cn"
    || parsedURL.hostname === "www.codebuddy.cn"
    || parsedURL.hostname.endsWith(".codebuddy.cn");
  if (parsedURL.protocol !== "https:" || !allowedHost) throw new ServiceError("UPSTREAM");

  const id = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await db.prepare("DELETE FROM oauth_session WHERE expires_at <= ?").bind(now).run();
  await db.prepare(`
    INSERT INTO oauth_session (id, state, created_at, expires_at, upstream_cookie, account_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(id, state, now, now + 300, mergeCookies("", result.setCookies), accountId).run();
  return { id, authUrl: parsedURL.href };
}

async function pollLogin(env, id) {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new ServiceError("BAD_REQUEST");
  }
  const db = requireDatabase(env);
  const session = await db.prepare(`
    SELECT state, expires_at, upstream_cookie, account_id FROM oauth_session WHERE id = ?
  `).bind(id).first();
  if (!session) throw new ServiceError("LOGIN_EXPIRED");

  const now = Math.floor(Date.now() / 1000);
  if (session.expires_at <= now) {
    await db.prepare("DELETE FROM oauth_session WHERE id = ?").bind(id).run();
    throw new ServiceError("LOGIN_EXPIRED");
  }

  const tokenResult = await upstreamJSON(
    `${loginBase}/v2/plugin/auth/token?state=${encodeURIComponent(session.state)}`,
    {
      method: "GET",
      headers: {
        ...headersFor(),
        ...(session.upstream_cookie ? { Cookie: session.upstream_cookie } : {}),
      },
    },
    { allowBusinessError: true },
  );
  const cookie = mergeCookies(session.upstream_cookie || "", tokenResult.setCookies);
  if (cookie !== (session.upstream_cookie || "")) {
    await db.prepare("UPDATE oauth_session SET upstream_cookie = ? WHERE id = ?").bind(cookie, id).run();
  }
  if (tokenResult.code !== 0 || !tokenResult.data?.accessToken) {
    return { status: "pending" };
  }

  const token = tokenResult.data;
  const accountResult = await upstreamJSON(
    `${loginBase}/v2/plugin/login/account?state=${encodeURIComponent(session.state)}`,
    {
      method: "GET",
      headers: {
        ...headersFor(),
        ...(cookie ? { Cookie: cookie } : {}),
        Authorization: `Bearer ${token.accessToken}`,
      },
    },
  );
  const identity = accountResult.data || {};
  if (!identity.uid || !token.refreshToken) throw new ServiceError("UPSTREAM");

  const existingAccountId = await accountIdForUID(identity.uid, env);
  const accountCount = await db.prepare("SELECT COUNT(*) AS count FROM accounts").first();
  if (!existingAccountId && Number(accountCount?.count || 0) >= maxAccounts) {
    throw new ServiceError("MAX_ACCOUNTS");
  }
  const accountId = existingAccountId || session.account_id || crypto.randomUUID();
  await saveAccount(accountId, {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: now + Math.max(60, Number(token.expiresIn) || 3600),
    domain: token.domain || "",
    uid: String(identity.uid),
    enterpriseId: identity.enterpriseId || "",
    nickname: identity.nickname || "WorkBuddy",
  }, env);
  await db.prepare("DELETE FROM oauth_session WHERE id = ?").bind(id).run();
  return { status: "connected", accountId };
}

function isAlreadyMessage(message) {
  return /already\s*(checked|check.?in|claimed)|已签到|今日已领|已经签到/i.test(message);
}

async function refreshAccount(accountId, account, env) {
  if (!account.refreshToken) throw new ServiceError("AUTH");
  const headers = {
    ...headersFor(account.domain),
    "X-Refresh-Token": account.refreshToken,
    "X-Auth-Refresh-Source": "workbuddy",
  };
  if (account.enterpriseId) headers["X-Enterprise-Id"] = account.enterpriseId;

  const result = await upstreamJSON(`${chatBase(account)}/v2/plugin/auth/token/refresh`, {
    method: "POST",
    headers,
  });
  const token = result.data || {};
  if (!token.accessToken) throw new ServiceError("AUTH");
  account.accessToken = token.accessToken;
  if (token.refreshToken) account.refreshToken = token.refreshToken;
  if (token.domain) account.domain = token.domain;
  if (Number(token.expiresIn) > 0) {
    account.expiresAt = Math.floor(Date.now() / 1000) + Number(token.expiresIn);
  }
  await saveAccount(accountId, account, env);
}

function billingHeaders(account) {
  const headers = {
    Authorization: `Bearer ${account.accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (account.uid) headers["X-User-Id"] = account.uid;
  if (account.enterpriseId) {
    headers["X-Enterprise-Id"] = account.enterpriseId;
    headers["X-Tenant-Id"] = account.enterpriseId;
  }
  if (account.domain) headers["X-Domain"] = account.domain;
  return headers;
}

async function claimCheckin(account) {
  return upstreamJSON(`${billingBase(account)}/v2/billing/meter/daily-checkin`, {
    method: "POST",
    headers: billingHeaders(account),
    body: "{}",
  }, { allowBusinessError: true });
}

async function readBalance(account) {
  const now = new Date();
  const until = new Date(now.getTime() + 365 * 101 * 24 * 60 * 60 * 1000);
  const fmt = (value) => value.toISOString().slice(0, 19).replace("T", " ");
  const result = await upstreamJSON(
    `${billingBase(account)}/v2/billing/meter/get-user-resource`,
    {
      method: "POST",
      headers: billingHeaders(account),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: "p_tcaca",
        Status: [0, 3],
        PackageEndTimeRangeBegin: fmt(now),
        PackageEndTimeRangeEnd: fmt(until),
      }),
    },
  );
  const rows = result.data?.Response?.Data?.Accounts || [];
  let total = 0;
  for (const row of rows) {
    let remain;
    if (Number(row.CycleCapacitySize) > 0) {
      remain = Number(row.CycleCapacityRemain);
    } else if (Number(row.CycleCapacityRemain) > 0 || Number(row.CycleCapacityUsed) > 0) {
      remain = Number(row.CycleCapacityRemain);
    } else {
      remain = Number(row.CapacityRemain);
    }
    if (Number.isFinite(remain)) total += Math.max(0, remain);
  }
  return Math.round(total);
}

function displayMessage(result, code) {
  if (result === "success") return "今日签到已完成";
  if (result === "already") return "今日已签到";
  if (code === "AUTH") return "登录已失效，请重新连接账号";
  if (code === "NO_ACCOUNT") return "请先连接 WorkBuddy 账号";
  if (code === "BUSY") return "已有一个签到任务正在运行";
  return "签到暂未完成，请稍后重试";
}

async function runCheckin(env, accountId) {
  const db = requireDatabase(env);
  if (typeof accountId !== "string" || (!/^[0-9a-f-]{36}$/i.test(accountId) && accountId !== "legacy")) {
    throw new ServiceError("BAD_REQUEST");
  }
  await db.prepare(`
    INSERT OR IGNORE INTO account_state (account_id, lock_until) VALUES (?, 0)
  `).bind(accountId).run();
  const now = Math.floor(Date.now() / 1000);
  const lock = await db.prepare(`
    UPDATE account_state SET lock_until = ?
    WHERE account_id = ? AND lock_until <= ?
  `).bind(now + 300, accountId, now).run();
  if (Number(lock.meta?.changes || 0) !== 1) {
    return { accountId, result: "busy", message: displayMessage("busy", "BUSY") };
  }

  try {
    const account = await loadAccount(accountId, env);
    if (!account) throw new ServiceError("NO_ACCOUNT");
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!account.expiresAt || account.expiresAt <= nowSeconds + 2 * 60 * 60) {
      await refreshAccount(accountId, account, env);
    }

    let result;
    try {
      result = await claimCheckin(account);
    } catch (error) {
      if (!(error instanceof ServiceError) || error.code !== "AUTH") throw error;
      await refreshAccount(accountId, account, env);
      result = await claimCheckin(account);
    }

    let checkinResult = "success";
    let code = "";
    if (result.code !== 0) {
      if (isAlreadyMessage(result.message)) {
        checkinResult = "already";
      } else {
        checkinResult = "failed";
        code = errorCodeFor(200, result.message);
      }
    }

    let balance = null;
    try {
      balance = await readBalance(account);
    } catch {
      // Balance is optional; a successful check-in remains successful if the query is unavailable.
    }
    const message = displayMessage(checkinResult, code);
    await updateRunState(env, accountId, checkinResult, message, balance);
    return { accountId, result: checkinResult, message, balance };
  } catch (error) {
    const code = error instanceof ServiceError ? error.code : "INTERNAL";
    const result = code === "AUTH" ? "reauth" : "failed";
    const message = displayMessage(result, code);
    await updateRunState(env, accountId, result, message);
    return { accountId, result, message, balance: null };
  } finally {
    await db.prepare("UPDATE account_state SET lock_until = 0 WHERE account_id = ?").bind(accountId).run();
  }
}

async function runAllCheckins(env) {
  const { results = [] } = await requireDatabase(env)
    .prepare("SELECT account_id FROM accounts ORDER BY connected_at, account_id")
    .all();
  const accounts = new Array(results.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(4, results.length) }, async () => {
    while (nextIndex < results.length) {
      const index = nextIndex++;
      const row = results[index];
      try {
        accounts[index] = await runCheckin(env, row.account_id);
      } catch (error) {
        const code = error instanceof ServiceError ? error.code : "INTERNAL";
        accounts[index] = {
          accountId: row.account_id,
          result: code === "AUTH" ? "reauth" : "failed",
          message: displayMessage("failed", code),
          balance: null,
        };
      }
    }
  });
  await Promise.all(workers);
  const completed = accounts.filter((account) => account.result === "success" || account.result === "already").length;
  const failed = accounts.length - completed;
  return {
    result: failed ? "failed" : "success",
    message: accounts.length
      ? failed ? `${completed}/${accounts.length} 个账号完成，${failed} 个需要检查` : `已完成 ${completed} 个账号签到`
      : "请先添加 WorkBuddy 账号",
    accounts,
  };
}

async function removeAccount(env, accountId) {
  if (!/^[0-9a-f-]{36}$/i.test(accountId) && accountId !== "legacy") {
    throw new ServiceError("BAD_REQUEST");
  }
  const db = requireDatabase(env);
  const now = Math.floor(Date.now() / 1000);
  const removed = await db.prepare(`
    DELETE FROM accounts WHERE account_id = ? AND NOT EXISTS (
      SELECT 1 FROM account_state WHERE account_id = ? AND lock_until > ?
    )
  `).bind(accountId, accountId, now).run();
  if (Number(removed.meta?.changes || 0) !== 1) {
    const exists = await db.prepare("SELECT 1 AS found FROM accounts WHERE account_id = ?")
      .bind(accountId).first();
    throw new ServiceError(exists ? "BUSY" : "NO_ACCOUNT");
  }
  await db.prepare("DELETE FROM account_state WHERE account_id = ?").bind(accountId).run();
  await db.prepare("DELETE FROM oauth_session WHERE account_id = ?").bind(accountId).run();
  if (accountId === "legacy") await db.prepare("DELETE FROM account WHERE id = 1").run();
  return { ok: true };
}

function statusCodeFor(error) {
  switch (error?.code) {
    case "BAD_REQUEST": return 400;
    case "BUSY": return 409;
    case "LOGIN_EXPIRED": return 410;
    case "AUTH_REQUIRED": return 401;
    case "DATABASE": return 503;
    case "MAX_ACCOUNTS": return 409;
    case "NO_ACCOUNT": return 404;
    default: return 502;
  }
}

function publicError(error) {
  switch (error?.code) {
    case "BAD_REQUEST": return "请求格式无效";
    case "LOGIN_EXPIRED": return "登录授权已过期，请重新开始";
    case "AUTH_REQUIRED": return "管理口令不正确";
    case "DATABASE": return "数据库尚未就绪";
    case "ENCRYPTION": return "账号加密配置不可用";
    case "BUSY": return "该账号正在签到，请稍后再试";
    case "MAX_ACCOUNTS": return `最多可连接 ${maxAccounts} 个账号`;
    case "NO_ACCOUNT": return "账号不存在或已移除";
    case "AUTH": return "WorkBuddy 登录已失效，请重新连接账号";
    case "UPSTREAM":
    case "BUSINESS": return "WorkBuddy 服务暂时未响应，请稍后重试";
    default: return "服务暂时不可用";
  }
}

async function serveAsset(request, env, pathname) {
  if (!env.ASSETS) return new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  url.pathname = pathname;
  const asset = await env.ASSETS.fetch(new Request(url, request));
  const headers = new Headers(asset.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  const revalidate = pathname === "/" || pathname === "/app.js" || pathname === "/app.css";
  headers.set("Cache-Control", revalidate ? "no-store" : "public, max-age=3600");
  if (pathname === "/" || pathname === "/index.html") {
    headers.set(
      "Content-Security-Policy",
      "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  }
  return new Response(asset.body, { status: asset.status, headers });
}

async function handleAPI(request, env, pathname) {
  if (!env.APP_PASSWORD) return json({ error: "服务尚未配置管理口令" }, 503);
  if (!isAuthorized(request, env)) {
    return json({ error: "管理口令不正确" }, 401);
  }

  if (pathname === "/api/status" && request.method === "GET") {
    return json(await readStatus(env));
  }
  if (pathname === "/api/login/start" && request.method === "POST") {
    return json(await startLogin(env));
  }
  if (pathname === "/api/login/poll" && request.method === "POST") {
    const body = await readBody(request);
    return json(await pollLogin(env, body.id));
  }
  if (pathname === "/api/run" && request.method === "POST") {
    const body = await readBody(request);
    const result = body.accountId
      ? await runCheckin(env, body.accountId)
      : await runAllCheckins(env);
    return json(result, result.result === "failed" || result.result === "reauth" ? 502 : 200);
  }
  const accountMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/);
  if (accountMatch && request.method === "DELETE") {
    return json(await removeAccount(env, decodeURIComponent(accountMatch[1])));
  }
  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return await serveAsset(request, env, "/");
      }
      if (request.method === "GET" && ["/app.css", "/app.js", "/workbuddy.png"].includes(url.pathname)) {
        return await serveAsset(request, env, url.pathname);
      }
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json({ ok: true, service: "workbuddy-checkin" });
      }
      if (url.pathname.startsWith("/api/")) {
        return await handleAPI(request, env, url.pathname);
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof ServiceError && error.code === "AUTH_REQUIRED") {
        return json({ error: publicError(error) }, statusCodeFor(error));
      }
      const status = statusCodeFor(error);
      return json({ error: publicError(error) }, status);
    }
  },

  async scheduled(_controller, env, context) {
    context.waitUntil(runAllCheckins(env).catch(() => {
      console.error("scheduled check-in batch failed");
    }));
  },
};
