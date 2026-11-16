// 喝水啦 推播伺服器（Cloudflare Worker，單檔、無外部套件）
// 需要的設定：
//   D1 資料庫綁定        DB
//   變數 VAPID_PUBLIC_KEY   （keygen.html 產生的「公鑰」）
//   密鑰 VAPID_PRIVATE_KEY  （keygen.html 產生的「私鑰」，請設成 Secret）
//   變數 VAPID_SUBJECT      例如 mailto:you@example.com
//   變數 ALLOWED_ORIGIN     例如 https://sen66star.github.io
//   Cron 觸發器            * * * * *（每分鐘）

/* ================== 文案 ==================
   嗆人台詞放在 GitHub 的 claude/lines.json（網頁和推播共用），每兩週換一半。
   改台詞只要改 GitHub 上的 lines.json，不用重新部署這裡；
   下面是讀不到 lines.json 時的備用台詞。 */
const LINES_URL = "https://sen66star.github.io/Drink-Water/claude/lines.json";
const LINES = {
  remind: [
    "喂～水杯在哭了，你聽到沒？",
    "我都快變仙人掌了，你還不喝？",
    "喝水時間到！不要假裝沒看到 👀",
    "你的腎臟傳訊息給我，說它很想你。",
    "再不喝水，我就自己去倒了（可惜我沒有手）",
    "叮咚！你的喝水外送到了，請簽收。",
    "人類 70% 是水，你現在大概剩 69%。",
    "放下手機…啊不對，先按「我喝了」再放下。",
    "今天的你，乾得像一塊蘇打餅乾。",
    "喝一口就好，我不貪心。好啦，兩口。",
    "{name} 舉牌抗議：我要喝水！你也要！",
    "水杯：我等你等到都退冰了。",
    "嘴唇乾乾的那個人，對，就是你。",
    "現在喝水，等一下會變好看（大概）。",
    "提醒你喝水的我，是不是很貼心？快誇我。",
    "再忙也不差這 10 秒吧？",
    "咕嚕咕嚕的聲音，我想聽。",
    "你再滑一下，我就再枯一點。"
  ],
  overdue: [
    "欠我 {owe} 杯喔，我都有記帳。",
    "你是不是忘記我了…葉子都垂下來了。",
    "已讀不喝，太過分了吧。",
    "我渴到開始寫遺書了（誇張）",
    "催第二次了喔，第三次我要叫你全名。",
    "你的水杯是不是已經長灰塵了？",
    "我不是在生氣，我只是很乾。",
    "還欠 {owe} 次，現在補喝還來得及。"
  ],
  test: [
    "測試成功！以後時間到我就會這樣叫你 💧",
    "叮！推播通了，App 關著我也找得到你。"
  ]
};

let poolCache = { at: 0, data: null };
async function getPool() {
  if (poolCache.data && Date.now() - poolCache.at < 60 * 60 * 1000) return poolCache.data;
  try {
    const r = await fetch(LINES_URL, { cf: { cacheTtl: 600 } });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j.remind) && Array.isArray(j.overdue)) poolCache = { at: Date.now(), data: j };
    }
  } catch (e) { console.log("lines.json 讀取失敗，用備用台詞", e && e.message); }
  return poolCache.data;
}
function activeLines(pool, cat, day) {
  const list = pool && pool[cat], half = pool && pool.half && pool.half[cat];
  if (!list || !list.length) return LINES[cat];
  if (!half || list.length < half * 2) return list;
  const [y1, m1, d1] = String(pool.anchor || "2026-11-16").split("-").map(Number), [y2, m2, d2] = day.split("-").map(Number);
  const diff = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
  const p = Math.floor(diff / (Number(pool.days) || 14)), k = Math.floor(list.length / half);
  const i = ((p % k) + k) % k, j = (i + 1) % k;
  return list.slice(i * half, i * half + half).concat(list.slice(j * half, j * half + half));
}

/* ================== 排程（和網頁的算法一致） ================== */
const toMin = t => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };
const pad = n => String(n).padStart(2, "0");
const fmt = m => pad(Math.floor(m / 60)) + ":" + pad(m % 60);
const pick = a => a[Math.floor(Math.random() * a.length)];

function isQuiet(m, s) {
  if (!s.quietOn) return false;
  const a = toMin(s.quietStart), b = toMin(s.quietEnd);
  if (a === b) return false;
  return a < b ? (m >= a && m < b) : (m >= a || m < b);
}
function slots(s) {
  let list = [];
  if (s.mode === "interval") {
    const step = Math.max(15, Number(s.interval) || 60);
    for (let m = toMin(s.startAt || "08:00"); m < 1440; m += step) list.push(m);
  } else {
    list = (s.times || []).filter(Boolean).map(toMin);
  }
  return [...new Set(list)].filter(m => Number.isFinite(m) && !isQuiet(m, s)).sort((a, b) => a - b);
}
function localNow(tz) {
  let f;
  try {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  } catch (e) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  }
  const p = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}

/* ================== Web Push（RFC 8291 + VAPID，純 WebCrypto） ================== */
const enc = new TextEncoder();
function b64u(buf) {
  const b = new Uint8Array(buf); let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64u(str) {
  const s = atob(String(str).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}
function concat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

const jwtCache = new Map();
async function vapidHeader(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const hit = jwtCache.get(aud);
  if (hit && hit.exp - now > 3600) return hit.header;
  const pub = unb64u(env.VAPID_PUBLIC_KEY);
  const key = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", d: env.VAPID_PRIVATE_KEY,
    x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const exp = now + 12 * 3600;
  const unsigned = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" }))) + "." +
    b64u(enc.encode(JSON.stringify({ aud, exp, sub: env.VAPID_SUBJECT || "mailto:admin@example.com" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned));
  const header = `vapid t=${unsigned}.${b64u(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
  jwtCache.set(aud, { exp, header });
  return header;
}

export async function encryptPayload(sub, text) {
  const uaPublic = unb64u(sub.keys.p256dh);
  const authSecret = unb64u(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const prkKey = await hmac(authSecret, shared);
  const ikm = (await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])))).slice(0, 32);
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, enc.encode("Content-Encoding: aes128gcm\0\x01"))).slice(0, 16);
  const nonce = (await hmac(prk, enc.encode("Content-Encoding: nonce\0\x01"))).slice(0, 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(enc.encode(text), new Uint8Array([2]))));
  const header = concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPublic.length]), asPublic);
  return concat(header, cipher);
}

async function sendPush(sub, payload, env) {
  const body = await encryptPayload(sub, JSON.stringify(payload));
  return fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Authorization": await vapidHeader(sub.endpoint, env),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "900",          // 15 分鐘內送不到就算了，不要半夜補發
      "Urgency": "high"
    },
    body
  });
}

/* ================== 資料庫 ================== */
let tableReady = false;
async function ensureTable(env) {
  if (tableReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS subs (
    id TEXT PRIMARY KEY, sub TEXT NOT NULL, settings TEXT NOT NULL, state TEXT NOT NULL,
    tz TEXT NOT NULL, last_sent TEXT NOT NULL DEFAULT '', updated INTEGER NOT NULL)`).run();
  tableReady = true;
}

/* ================== 每分鐘檢查 ================== */
function buildMessage(row, s, st, now, kind, pool) {
  const list = slots(s);
  const past = list.filter(m => m <= now.min);
  const count = st.day === now.day ? (Number(st.count) || 0) : 0;
  const owe = Math.max(0, past.length - count);
  const next = list.find(m => m > now.min);
  const lines = kind === "test" ? LINES.test : activeLines(pool, owe > 1 ? "overdue" : "remind", now.day);
  const body = pick(lines)
    .replace("{name}", s.plantName || "小芽")
    .replace("{owe}", owe)
    .replace("{next}", next !== undefined ? fmt(next) : "明天");
  return { title: "喝水啦 💧", body, badge: owe };
}

async function runSchedule(env) {
  await ensureTable(env);
  const { results } = await env.DB.prepare("SELECT * FROM subs").all();
  const updates = [];
  const pool = results.length ? await getPool() : null;
  await Promise.all(results.map(async row => {
    try {
      const s = JSON.parse(row.settings), st = JSON.parse(row.state), sub = JSON.parse(row.sub);
      const now = localNow(row.tz);
      const past = slots(s).filter(m => m <= now.min);
      if (!past.length) return;
      const last = past[past.length - 1];
      const key = `${now.day} ${fmt(last)}`;
      if (row.last_sent === key || now.min - last > 5) return;   // 已送過，或錯過太久就不補
      updates.push(env.DB.prepare("UPDATE subs SET last_sent = ? WHERE id = ?").bind(key, row.id));
      if (Date.now() - (Number(st.lastDrink) || 0) < 15 * 60 * 1000) return;   // 剛喝過就不吵
      const res = await sendPush(sub, buildMessage(row, s, st, now, "remind", pool), env);
      if (res.status === 404 || res.status === 410) {
        updates.push(env.DB.prepare("DELETE FROM subs WHERE id = ?").bind(row.id));   // 訂閱失效
      } else if (!res.ok) {
        console.log("push failed", row.id, res.status, await res.text());
      }
    } catch (e) {
      console.log("row error", row.id, e && e.message);
    }
  }));
  if (updates.length) await env.DB.batch(updates);
}

/* ================== API ================== */
const PUSH_HOSTS = [/^web\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];
const okId = id => typeof id === "string" && /^[A-Za-z0-9-]{16,64}$/.test(id);

function cors(env, req) {
  const allow = env.ALLOWED_ORIGIN || "*";
  const origin = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": allow === "*" ? "*" : (origin === allow ? origin : allow),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}
const json = (obj, status, headers) => new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json" } });

function cleanSettings(s = {}) {
  const t = v => (typeof v === "string" && /^\d{2}:\d{2}$/.test(v) ? v : null);
  return {
    mode: s.mode === "custom" ? "custom" : "interval",
    interval: Math.min(720, Math.max(15, Number(s.interval) || 90)),
    startAt: t(s.startAt) || "08:00",
    times: (Array.isArray(s.times) ? s.times : []).map(t).filter(Boolean).slice(0, 48),
    quietOn: !!s.quietOn,
    quietStart: t(s.quietStart) || "22:30",
    quietEnd: t(s.quietEnd) || "07:30",
    plantName: String(s.plantName || "小芽").slice(0, 8)
  };
}

async function handle(req, env) {
  const h = cors(env, req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  const path = new URL(req.url).pathname;

  if (req.method === "GET" && path === "/vapid") return json({ key: env.VAPID_PUBLIC_KEY }, 200, h);
  if (req.method === "GET" && path === "/") return new Response("喝水啦推播伺服器運作中 💧", { headers: { ...h, "Content-Type": "text/plain; charset=utf-8" } });
  if (req.method !== "POST") return json({ error: "not found" }, 404, h);

  const raw = await req.text();
  if (raw.length > 8000) return json({ error: "too large" }, 413, h);
  let b; try { b = JSON.parse(raw); } catch (e) { return json({ error: "bad json" }, 400, h); }
  if (!okId(b.id)) return json({ error: "bad id" }, 400, h);
  await ensureTable(env);

  if (path === "/sync") {
    const sub = b.sub;
    let host = "";
    try { host = new URL(sub.endpoint).hostname; } catch (e) {}
    if (!sub || !sub.keys || !sub.keys.p256dh || !sub.keys.auth || !String(sub.endpoint).startsWith("https://") || !PUSH_HOSTS.some(r => r.test(host)))
      return json({ error: "bad subscription" }, 400, h);
    const st = b.state || {};
    const state = { day: String(st.day || "").slice(0, 10), count: Number(st.count) || 0, lastDrink: Number(st.lastDrink) || 0 };
    let tz = String(b.tz || "Asia/Taipei").slice(0, 64);
    try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch (e) { tz = "Asia/Taipei"; }
    await env.DB.prepare(`INSERT INTO subs (id, sub, settings, state, tz, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(id) DO UPDATE SET sub = ?2, settings = ?3, state = ?4, tz = ?5, updated = ?6`)
      .bind(b.id, JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }),
        JSON.stringify(cleanSettings(b.settings)), JSON.stringify(state), tz, Date.now()).run();
    return json({ ok: true }, 200, h);
  }

  if (path === "/unsubscribe") {
    await env.DB.prepare("DELETE FROM subs WHERE id = ?").bind(b.id).run();
    return json({ ok: true }, 200, h);
  }

  if (path === "/test") {
    const row = await env.DB.prepare("SELECT * FROM subs WHERE id = ?").bind(b.id).first();
    if (!row) return json({ error: "not subscribed" }, 404, h);
    const msg = buildMessage(row, JSON.parse(row.settings), JSON.parse(row.state), localNow(row.tz), "test");
    const res = await sendPush(JSON.parse(row.sub), msg, env);
    if (res.status === 404 || res.status === 410) await env.DB.prepare("DELETE FROM subs WHERE id = ?").bind(b.id).run();
    return json({ ok: res.ok, status: res.status }, res.ok ? 200 : 502, h);
  }

  return json({ error: "not found" }, 404, h);
}

export default {
  async fetch(req, env) {
    try { return await handle(req, env); }
    catch (e) { return json({ error: String(e && e.message || e) }, 500, cors(env, req)); }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSchedule(env));
  }
};
