// 喝水啦 推播伺服器（Cloudflare Worker，單檔、無外部套件）
// 需要的設定：
//   D1 資料庫綁定        DB
//   變數 VAPID_PUBLIC_KEY   （keygen.html 產生的「公鑰」）
//   密鑰 VAPID_PRIVATE_KEY  （keygen.html 產生的「私鑰」，請設成 Secret）
//   變數 VAPID_SUBJECT      例如 mailto:you@example.com
//   變數 ALLOWED_ORIGIN     例如 https://sen66star.github.io
//   Cron 觸發器            * * * * *（每分鐘）
//   Workers AI 綁定        AI（自訂習慣的台詞用 AI 寫）

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
  sit: [
    "你的屁股已經跟椅子結婚了，快起來離婚。",
    "坐太久囉！站起來伸個懶腰吧 🙆",
    "起來走兩步，{name} 幫你顧位子。",
    "站起來動一動，腰會感謝你的。"
  ],
  sitTail: [
    "順便起來走兩步 🚶",
    "倒水的路上，順便伸個懶腰吧。"
  ],
  habit: {
    remind: [
      "{item}的時間到了，別裝沒看到 👀",
      "叮！該{item}了，{name} 在旁邊盯著你。",
      "說好要{item}的，現在就是那個「等一下」。",
      "{item}只要幾分鐘，拖延才花時間。",
      "我都準時叫你了，{item}就交給你了。",
      "今天的{item}還沒打勾喔。"
    ],
    overdue: [
      "{item}還沒做喔，我都有記著。",
      "已讀不{item}，太過分了吧。",
      "催第二次了，{item}到底做了沒？",
      "再不{item}，{name} 要開始碎碎念了。"
    ]
  },
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
/* ---------- 久坐提醒（和網頁的算法一致） ---------- */
const MERGE = 10;   // 跟喝水提醒差 10 分鐘以內就合併成一則
function sitSlots(s, now) {
  if (!s.sitOn) return [];
  if (!(s.sitDays || []).includes(now.wd)) return [];
  let list = [];
  if (s.sitMode === "custom") {
    list = (s.sitTimes || []).filter(Boolean).map(toMin);
  } else {
    const a = toMin(s.sitStart || "09:00"), b = toMin(s.sitEnd || "18:00"), step = Math.max(15, Number(s.sitInterval) || 60);
    for (let m = a + step; m <= b; m += step) list.push(m);
  }
  return [...new Set(list)].filter(m => Number.isFinite(m) && !isQuiet(m, s)).sort((x, y) => x - y);
}
/* ---------- 自訂習慣（和網頁的算法一致） ---------- */
const NAG = 30;   // 時間到 30 分鐘後還沒做，再催一次
function habitSlots(h, s, now) {
  if (!h.on || !(h.days || []).includes(now.wd)) return [];
  // 家人設的提醒（有 from）是特別挑的時間，不受勿擾時段影響
  return [...new Set((h.times || []).filter(Boolean).map(toMin))].filter(m => Number.isFinite(m) && (h.from || !isQuiet(m, s))).sort((a, b) => a - b);
}
const habitAt = (s, now, m) => (s.habits || []).some(h => habitSlots(h, s, now).some(x => Math.abs(x - m) <= MERGE));
function localNow(tz) {
  let f;
  try {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" });
  } catch (e) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" });
  }
  const p = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { day: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute), wd };
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
    tz TEXT NOT NULL, last_sent TEXT NOT NULL DEFAULT '', updated INTEGER NOT NULL,
    last_sit TEXT NOT NULL DEFAULT '')`).run();
  try { await env.DB.prepare("ALTER TABLE subs ADD COLUMN last_sit TEXT NOT NULL DEFAULT ''").run(); } catch (e) {}   // 舊資料表補欄位
  try { await env.DB.prepare("ALTER TABLE subs ADD COLUMN last_habit TEXT NOT NULL DEFAULT ''").run(); } catch (e) {}
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS gen_quota (id TEXT PRIMARY KEY, day TEXT NOT NULL, n INTEGER NOT NULL)").run();
  // 家園
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS fam_users (id TEXT PRIMARY KEY, name TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '21:30', last_summary TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, from_id TEXT NOT NULL, type TEXT NOT NULL, created INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL, type TEXT NOT NULL, nick_a TEXT NOT NULL DEFAULT '', nick_b TEXT NOT NULL DEFAULT '', poke_a INTEGER NOT NULL DEFAULT 0, poke_b INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS assigned (id TEXT PRIMARY KEY, link TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, habit TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS donelog (hid TEXT NOT NULL, day TEXT NOT NULL, done TEXT NOT NULL, PRIMARY KEY (hid, day))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS stickers (id INTEGER PRIMARY KEY AUTOINCREMENT, link TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, sticker TEXT NOT NULL, at INTEGER NOT NULL)")
  ]);
  try { await env.DB.prepare("ALTER TABLE assigned ADD COLUMN snooze TEXT NOT NULL DEFAULT ''").run(); } catch (e) {}   // 「等等我」延後提醒
  tableReady = true;
}

/* ================== 每分鐘檢查 ================== */
function buildMessage(row, s, st, now, kind, pool, withSit) {
  const list = slots(s);
  const past = list.filter(m => m <= now.min);
  const count = st.day === now.day ? (Number(st.count) || 0) : 0;
  const owe = Math.max(0, past.length - count);
  const next = list.find(m => m > now.min);
  const fill = t => t.replace("{name}", s.plantName || "小芽").replace("{owe}", owe).replace("{next}", next !== undefined ? fmt(next) : "明天");
  // iPhone 會自動在標題下面加一行「from 喝水啦」，所以台詞直接當標題，不再重複寫「喝水啦」
  if (kind === "sit") return { title: fill(pick(activeLines(pool, "sit", now.day))), body: "", badge: owe, tag: "sit" };
  if (kind === "habit" || kind === "habit-nag") {
    const h = withSit.h, cat = kind === "habit" ? "remind" : "overdue";
    const own = h.lines && Array.isArray(h.lines[cat]) ? h.lines[cat].filter(Boolean) : [];
    const title = fill(pick(own.length ? own : LINES.habit[cat]).replace(/\{item\}/g, h.name));
    return { title, body: withSit.tail || "", badge: owe, tag: "habit-" + h.id };   // tail：第二行（合併、誰設的、等等我）
  }
  const lines = kind === "test" ? LINES.test : activeLines(pool, owe > 1 ? "overdue" : "remind", now.day);
  const body = withSit ? fill(pick(activeLines(pool, "sitTail", now.day))) : "";
  return { title: fill(pick(lines)), body, badge: owe, tag: "drink" };
}

async function runSchedule(env) {
  await ensureTable(env);
  const { results } = await env.DB.prepare("SELECT * FROM subs").all();
  const updates = [];
  const pool = results.length ? await getPool() : null;
  const fam = results.length ? await loadFamily(env) : null;
  const rowsById = Object.fromEntries(results.map(r => [r.id, r]));
  await Promise.all(results.map(async row => {
    try {
      const s = JSON.parse(row.settings), st = JSON.parse(row.state), sub = JSON.parse(row.sub);
      const now = localNow(row.tz);
      // 家人幫我設的提醒，跟自己的習慣一起排
      const mine = (fam.byTo[row.id] || []).filter(a => !a.paused);
      if (mine.length) s.habits = [...(s.habits || []), ...mine.map(a => ({ ...a.habit, id: a.id, on: true, from: fam.nickFor(a.link, row.id), snooze: a.snooze }))];
      const water = slots(s), sits = sitSlots(s, now);
      const fill = t => String(t).replace(/\{name\}/g, s.plantName || "小芽");
      const recent = Date.now() - (Number(st.lastDrink) || 0) < 15 * 60 * 1000;   // 剛喝過就不吵
      const send = async msg => {
        const res = await sendPush(sub, msg, env);
        if (res.status === 404 || res.status === 410) {
          updates.push(env.DB.prepare("DELETE FROM subs WHERE id = ?").bind(row.id));   // 訂閱失效
        } else if (!res.ok) {
          console.log("push failed", row.id, res.status, await res.text());
        }
      };

      // 自訂習慣：時間到提醒一次，30 分鐘後還沒做再催一次；同時間的喝水、久坐併進這一則
      let fired = {};
      try { fired = JSON.parse(row.last_habit || "{}") || {}; } catch (e) { fired = {}; }
      const done = (st.habitDone && typeof st.habitDone === "object") ? st.habitDone : {};
      let firedChanged = false;
      for (const h of s.habits || []) {
        for (const m of habitSlots(h, s, now)) {
          const k = `${h.id} ${now.day} ${fmt(m)}`, nk = k + " nag";
          const isDone = ((done[h.id] || []).includes(`${now.day} ${m}`));
          if (m <= now.min && !fired[k]) {
            fired[k] = 1; firedChanged = true;
            if (now.min - m <= 5) {
              const others = (s.habits || []).filter(o => o.id !== h.id && habitSlots(o, s, now).some(x => Math.abs(x - m) <= MERGE));
              let tail = others.length ? "還有：" + others.map(o => o.name).join("、") : "";
              if (!tail && water.some(x => Math.abs(x - m) <= MERGE)) tail = "順便喝口水 💧";
              else if (!tail && sits.some(x => Math.abs(x - m) <= MERGE)) tail = fill(pick(activeLines(pool, "sitTail", now.day)));
              else if (!tail && h.from) tail = `${h.from}幫你設的提醒`;
              await send(buildMessage(row, s, st, now, "habit", pool, { h, tail }));
            }
          }
          // 按了「等等我」：時間到再提醒一次，原本 30 分鐘後的催促就不送
          const sz = h.snooze && h.snooze.day === now.day && h.snooze.slot === m ? h.snooze : null;
          if (sz && now.min >= sz.until && !fired[k + " snz"]) {
            fired[k + " snz"] = 1; fired[nk] = 1; firedChanged = true;
            if (now.min - sz.until <= 5 && !isDone) await send(buildMessage(row, s, st, now, "habit-nag", pool, { h, tail: "說好的待會兒，就是現在喔" }));
          }
          if (m + NAG <= now.min && !fired[nk]) {
            fired[nk] = 1; firedChanged = true;
            if (now.min - (m + NAG) <= 5 && !isDone && !sz) await send(buildMessage(row, s, st, now, "habit-nag", pool, { h }));
          }
        }
      }
      if (firedChanged) {
        // 只留今天的紀錄，避免越存越大
        const keep = Object.fromEntries(Object.entries(fired).filter(([k]) => k.includes(" " + now.day + " ")));
        updates.push(env.DB.prepare("UPDATE subs SET last_habit = ? WHERE id = ?").bind(JSON.stringify(keep), row.id));
      }

      // 喝水提醒（附近有久坐提醒就合併成一則；有習慣同時提醒就併進習慣那一則）
      const past = water.filter(m => m <= now.min);
      if (past.length) {
        const last = past[past.length - 1];
        const key = `${now.day} ${fmt(last)}`;
        if (row.last_sent !== key && now.min - last <= 5) {   // 沒送過，而且沒錯過太久
          updates.push(env.DB.prepare("UPDATE subs SET last_sent = ? WHERE id = ?").bind(key, row.id));
          if (!recent && !habitAt(s, now, last)) {
            const withSit = sits.some(m => Math.abs(m - last) <= MERGE);
            await send(buildMessage(row, s, st, now, "remind", pool, withSit));
          }
        }
      }

      // 久坐提醒（跟喝水撞在一起的，已經合併在上面那則）
      const sitPast = sits.filter(m => m <= now.min);
      if (sitPast.length) {
        const last = sitPast[sitPast.length - 1];
        const key = `${now.day} ${fmt(last)}`;
        if (row.last_sit !== key && now.min - last <= 5) {
          updates.push(env.DB.prepare("UPDATE subs SET last_sit = ? WHERE id = ?").bind(key, row.id));
          if (!water.some(m => Math.abs(m - last) <= MERGE) && !habitAt(s, now, last)) await send(buildMessage(row, s, st, now, "sit", pool));
        }
      }
      // 家園：晚上摘要（只有家人還沒做完才送）
      const me = fam.users[row.id];
      if (me && me.last_summary !== now.day) {
        const at = toMin(me.summary || "21:30");
        if (now.min >= at && now.min - at <= 5) {
          updates.push(env.DB.prepare("UPDATE fam_users SET last_summary = ? WHERE id = ?").bind(now.day, row.id));
          const lines = familySummary(fam, rowsById, row.id);
          if (lines.length) await send({ title: "家人今天還沒做完 🌱", body: lines.join("\n"), tag: "fam-summary" });
        }
      }
    } catch (e) {
      console.log("row error", row.id, e && e.message);
    }
  }));
  if (updates.length) await env.DB.batch(updates);
}

/* ================== AI 寫台詞（Cloudflare Workers AI） ================== */
const AI_MODELS = ["@cf/qwen/qwen3-30b-a3b-fp8", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/mistralai/mistral-small-3.1-24b-instruct"];
// 提示詞放在 GitHub 的 claude/ai-prompt.txt，改那個檔案就能調整台詞風格，不用重新部署；讀不到才用下面這份備用
const PROMPT_URL = "https://raw.githubusercontent.com/sen66star/Drink-Water/main/claude/ai-prompt.txt";
let promptCache = { at: 0, text: "" };
async function aiPrompt(name, plant) {
  if (!promptCache.text || Date.now() - promptCache.at > 2 * 60 * 1000) {
    try {
      const r = await fetch(PROMPT_URL + "?v=" + Math.floor(Date.now() / 60000));
      if (r.ok) {
        const t = (await r.text()).split("\n").filter(l => !l.startsWith("#")).join("\n").trim();
        if (t.includes("{habit}") && t.length > 100) promptCache = { at: Date.now(), text: t };
      }
    } catch (e) { console.log("ai-prompt.txt 讀取失敗，用備用提示詞", e && e.message); }
  }
  if (promptCache.text) return promptCache.text.replace(/\{habit\}/g, name).replace(/\{plant\}/g, plant);
  return builtinPrompt(name, plant);
}
function builtinPrompt(name, plant) {
  return `你是一盆會說話的小植物，名字叫「${plant}」，住在一個養成習慣的手機 App 裡，個性俏皮、愛鬧、會嗆人但不刻薄，像好朋友一樣催主人。
主人想養成的習慣是：「${name}」。

請寫三組台詞，全部用繁體中文、台灣口語（不要簡體字、不要中國用語）：
1. remind：時間到了提醒主人去做「${name}」，12 句。
2. overdue：提醒過了主人還沒做，再催一次，語氣更急、像在催債，6 句。
3. done：主人做完了，誇獎或鬧他一下，6 句。

規則：
- 每句 8～22 個字，一句一行，不要編號。
- 台詞要跟「${name}」這件事有關，有畫面、有梗，不要只是「記得${name}」。
- 可以偶爾放一個 emoji，不要每句都放。
- 可以在少數幾句用 {name} 代表植物自己的名字。
- 不要提到生病、死亡、身材、宗教、政治，不要給任何醫療或專業建議。
- 只輸出 JSON，格式：{"remind":[...],"overdue":[...],"done":[...]}，不要其他文字。`;
}
function cleanLines(arr, min, max) {
  const seen = new Set(), opens = {};
  let tilde = 0;
  const out = [];
  for (let x of (Array.isArray(arr) ? arr : [])) {
    x = String(x).replace(/^\s*[-*•]?\s*[\d一二三四五六七八九十]+[\.、\)）]\s*/, "").replace(/^["「『]|["」』]$/g, "").trim();
    if (/[～~]$/.test(x)) { tilde++; if (tilde > 2) x = x.replace(/[～~]+$/, "").replace(/[啦啊]$/, "") + (/[？！。]$/.test(x) ? "" : "。"); }
    const op = x.slice(0, 3);
    if (x.length < 4 || x.length > 40 || seen.has(x) || (opens[op] || 0) >= 2) continue;   // 同樣開頭最多 2 句
    seen.add(x); opens[op] = (opens[op] || 0) + 1;
    out.push(x);
    if (out.length >= max) break;
  }
  return out;
}
function extractJSON(text) {
  if (text && typeof text === "object") return text;   // 有些模型會直接回傳已解析的物件
  const t = String(text).replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("沒有 JSON：" + t.slice(0, 80));
  return JSON.parse(t.slice(a, b + 1));
}
function aiText(r) {
  if (r == null) return "";
  if (typeof r === "string") return r;
  if (r.response != null) return r.response;
  const c = r.choices && r.choices[0];
  if (c) return (c.message && (c.message.content || c.message.reasoning_content)) || c.text || "";
  if (r.result) return aiText(r.result);
  return r;
}
async function generateLines(env, name, plant) {
  const errs = [];
  for (const model of AI_MODELS) {
    try {
      const messages = [
        { role: "system", content: "你只會輸出 JSON。/no_think" },
        { role: "user", content: await aiPrompt(name, plant) }
      ];
      const r = await env.AI.run(model, { messages, max_tokens: 3000, temperature: 0.95 });
      const j = extractJSON(aiText(r));
      const out = { remind: cleanLines(j.remind, 6, 12), overdue: cleanLines(j.overdue, 3, 6), done: cleanLines(j.done, 3, 6), model };
      if (out.remind.length < 6 || out.overdue.length < 3 || out.done.length < 3)
        throw new Error(`句子太少（${out.remind.length}/${out.overdue.length}/${out.done.length}）`);
      return out;
    } catch (e) {
      const msg = `${model.split("/").pop()}：${String(e && e.message || e).slice(0, 160)}`;
      errs.push(msg); console.log("AI model failed", msg);
    }
  }
  const err = new Error("AI failed"); err.detail = errs; throw err;
}

/* ================== 家園（家人提醒） ================== */
const FAM_MAX = 5, ASSIGN_MAX = 6;
// 貼圖代號 → 通知裡顯示的文字（要跟網頁的 STICKERS 一致）
const STICKERS = { s01:"早安 🌅", s02:"晚安 🌙", s03:"想你 🥺", s04:"愛你 ❤️", s05:"抱抱 🤗", s06:"加油 💪", s07:"辛苦了 🍵", s08:"謝謝 🙏", s09:"哈哈哈 😂", s10:"讚 👍",
  s11:"吃飯沒 🍚", s12:"多喝水 💧", s13:"早點睡 😴", s14:"收到 🫡", s15:"OK 👌", s16:"哭哭 😭", s17:"生氣氣 😤", s18:"在嗎？ 👀", s19:"出門小心 ☂️", s20:"到家了 🏠",
  s21:"哇噻 🤩", s22:"歐耶 🥳", s23:"啊啊啊 🤯", s24:"嗚嗚嗚 🥹", s25:"嘿嘿 😎" };
const CODE_CHARS = "0123456789";   // 邀請碼只用數字，長輩比較好輸入
const rid = (n, chars = "abcdefghijkmnpqrstuvwxyz23456789") => Array.from(crypto.getRandomValues(new Uint8Array(n)), x => chars[x % chars.length]).join("");
function cleanHabit(h) {
  const t = v => (typeof v === "string" && /^\d{2}:\d{2}$/.test(v) ? v : null);
  return {
    name: String(h.name || "").trim().slice(0, 10),
    emoji: String(h.emoji || "").slice(0, 4),
    days: (Array.isArray(h.days) ? h.days : []).map(Number).filter(d => d >= 0 && d <= 6),
    times: (Array.isArray(h.times) ? h.times : []).map(t).filter(Boolean).slice(0, 6),
    lines: Object.fromEntries(["remind", "overdue", "done"].map(c => [c, (h.lines && Array.isArray(h.lines[c]) ? h.lines[c] : []).map(x => String(x).slice(0, 60)).slice(0, 20)]))
  };
}
// 誰能看、能管：互相照顧兩邊都可以；我照顧你只有 a（邀請的人）可以
const canManage = (l, me) => l.type === "mutual" || l.a === me;
const otherOf = (l, me) => (l.a === me ? l.b : l.a);
const myNickFor = (l, me) => (l.a === me ? l.nick_a : l.nick_b);   // 我怎麼稱呼對方

async function loadFamily(env) {
  const [u, l, a] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM fam_users"),
    env.DB.prepare("SELECT * FROM links"),
    env.DB.prepare("SELECT * FROM assigned")
  ]);
  const users = Object.fromEntries((u.results || []).map(x => [x.id, x]));
  const links = Object.fromEntries((l.results || []).map(x => [x.id, x]));
  const byTo = {}, byFrom = {};
  for (const x of a.results || []) {
    let habit = {}; try { habit = JSON.parse(x.habit); } catch (e) {}
    let snooze = null; try { snooze = x.snooze ? JSON.parse(x.snooze) : null; } catch (e) {}
    const item = { id: x.id, link: x.link, from: x.from_id, to: x.to_id, paused: !!x.paused, created: x.created, snooze, habit };
    (byTo[x.to_id] = byTo[x.to_id] || []).push(item);
    (byFrom[x.from_id] = byFrom[x.from_id] || []).push(item);
  }
  // 收到提醒的人怎麼稱呼設提醒的人：先用他取的暱稱，沒有就用對方自己的名字
  const nickFor = (linkId, me) => {
    const lk = links[linkId]; if (!lk) return "家人";
    const other = otherOf(lk, me);
    return myNickFor(lk, me) || (users[other] && users[other].name) || "家人";
  };
  return { users, links, byTo, byFrom, nickFor };
}
function habitDueToday(habit, row, now) {
  if (!(habit.days || []).includes(now.wd)) return [];
  return [...new Set((habit.times || []).map(toMin))].filter(m => m <= now.min).sort((x, y) => x - y);
}
function doneToday(row, hid, day) {
  let st = {}; try { st = JSON.parse(row.state); } catch (e) {}
  return ((st.habitDone || {})[hid] || []).filter(k => k.startsWith(day)).map(k => Number(k.slice(11)));
}
function familySummary(fam, rowsById, me) {
  const out = {};
  for (const a of fam.byFrom[me] || []) {
    const lk = fam.links[a.link]; if (!lk || a.paused || !canManage(lk, me)) continue;
    const row = rowsById[a.to]; if (!row) continue;
    const now = localNow(row.tz);
    const due = habitDueToday(a.habit, row, now), done = doneToday(row, a.id, now.day);
    if (due.some(m => !done.includes(m))) {
      const who = myNickFor(lk, me) || (fam.users[a.to] && fam.users[a.to].name) || "家人";
      (out[who] = out[who] || []).push(a.habit.name);
    }
  }
  return Object.entries(out).map(([who, list]) => `${who}：${list.join("、")}`);
}
async function logAssignedDone(env, id, hd) {
  const ids = Object.keys(hd).filter(k => k.startsWith("f"));
  if (!ids.length) return;
  const { results } = await env.DB.prepare(`SELECT id FROM assigned WHERE to_id = ? AND id IN (${ids.map(() => "?").join(",")})`).bind(id, ...ids).all();
  const ops = [];
  for (const { id: hid } of results || []) {
    const byDay = {};
    for (const k of hd[hid] || []) { const day = k.slice(0, 10), m = Number(k.slice(11)); if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(m)) (byDay[day] = byDay[day] || []).push(m); }
    for (const [day, list] of Object.entries(byDay))
      ops.push(env.DB.prepare("INSERT INTO donelog (hid, day, done) VALUES (?1, ?2, ?3) ON CONFLICT(hid, day) DO UPDATE SET done = ?3").bind(hid, day, JSON.stringify([...new Set(list)])));
  }
  if (ops.length) await env.DB.batch(ops);
}
function plantOf(row) {
  if (!row) return null;
  let s = {}, st = {};
  try { s = JSON.parse(row.settings); st = JSON.parse(row.state); } catch (e) {}
  const now = localNow(row.tz);
  const past = slots(s).filter(m => m <= now.min).length;
  const count = st.day === now.day ? (Number(st.count) || 0) : 0;
  return { total: Number(st.total) || 0, owe: Math.max(0, past - count), plantName: s.plantName || "小芽",
    lastDrink: Number(st.lastDrink) || 0, lastHabit: st.lastHabit || null };
}

async function familyApi(action, b, env, h) {
  const me = b.id;
  const now = Date.now();
  const user = me ? await env.DB.prepare("SELECT * FROM fam_users WHERE id = ?").bind(me).first() : null;
  const linkOf = async lid => {
    const l = await env.DB.prepare("SELECT * FROM links WHERE id = ?").bind(String(lid || "")).first();
    return l && (l.a === me || l.b === me) ? l : null;
  };

  if (action === "peek") {   // 落地頁：顯示誰邀請你
    const inv = await env.DB.prepare("SELECT * FROM invites WHERE code = ?").bind(String(b.code || "").toUpperCase()).first();
    if (!inv || now - inv.created > 7 * 86400000) return json({ error: "邀請碼不存在或已過期" }, 404, h);
    const from = await env.DB.prepare("SELECT name FROM fam_users WHERE id = ?").bind(inv.from_id).first();
    return json({ fromName: from ? from.name : "家人", type: inv.type }, 200, h);
  }

  if (action === "profile") {
    const name = String(b.name || "").trim().slice(0, 10);
    if (!name && !user) return json({ error: "請先填你的名字" }, 400, h);
    const summary = /^\d{2}:\d{2}$/.test(b.summary || "") ? b.summary : (user ? user.summary : "21:30");
    await env.DB.prepare(`INSERT INTO fam_users (id, name, summary, created) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(id) DO UPDATE SET name = CASE WHEN ?2 = '' THEN name ELSE ?2 END, summary = ?3`).bind(me, name, summary, now).run();
    return json({ ok: true }, 200, h);
  }

  if (!user) return json({ error: "請先填你的名字", needName: true }, 400, h);

  if (action === "state") {
    const fam = await loadFamily(env);
    const mineLinks = Object.values(fam.links).filter(l => l.a === me || l.b === me);
    const otherIds = mineLinks.map(l => otherOf(l, me));
    const rows = otherIds.length ? (await env.DB.prepare(`SELECT * FROM subs WHERE id IN (${otherIds.map(() => "?").join(",")})`).bind(...otherIds).all()).results || [] : [];
    const rowsById = Object.fromEntries(rows.map(r => [r.id, r]));
    // 近 7 天的完成紀錄
    const ids = (fam.byFrom[me] || []).map(a => a.id);
    const logs = ids.length ? (await env.DB.prepare(`SELECT * FROM donelog WHERE hid IN (${ids.map(() => "?").join(",")})`).bind(...ids).all()).results || [] : [];
    const logBy = {};
    for (const x of logs) { try { (logBy[x.hid] = logBy[x.hid] || {})[x.day] = JSON.parse(x.done); } catch (e) {} }
    const family = mineLinks.map(l => {
      const other = otherOf(l, me), manage = canManage(l, me), row = rowsById[other];
      const role = l.type === "mutual" ? "mutual" : (l.a === me ? "carer" : "cared");
      const lastPoke = l.a === me ? l.poke_a : l.poke_b;
      return {
        link: l.id, role, nick: myNickFor(l, me), name: (fam.users[other] && fam.users[other].name) || "家人",
        push: !!row,
        plant: manage ? plantOf(row) : null,
        today: row ? localNow(row.tz).day : null,
        pokeWait: Math.max(0, Math.ceil((lastPoke + 3600000 - now) / 1000)),
        assigned: manage ? (fam.byFrom[me] || []).filter(a => a.link === l.id).map(a => {
          const log = { ...(logBy[a.id] || {}) };
          if (row) { const d = localNow(row.tz).day; log[d] = doneToday(row, a.id, d); }
          const snz = a.snooze && row && a.snooze.day === localNow(row.tz).day ? a.snooze : null;
          return { id: a.id, paused: a.paused, created: a.created, snooze: snz, ...a.habit, log };
        }) : []
      };
    });
    const forMe = (fam.byTo[me] || []).map(a => ({ id: a.id, paused: a.paused, from: fam.nickFor(a.link, me), link: a.link, snooze: a.snooze, ...a.habit }));
    // 最近 30 天、每位家人最多 20 則貼圖
    const linkIds = mineLinks.map(l => l.id);
    const stk = linkIds.length ? (await env.DB.prepare(`SELECT * FROM stickers WHERE link IN (${linkIds.map(() => "?").join(",")}) AND at > ? ORDER BY at DESC LIMIT 100`).bind(...linkIds, now - 30 * 86400000).all()).results || [] : [];
    const stickers = stk.map(x => ({ link: x.link, mine: x.from_id === me, sticker: x.sticker, at: x.at }));
    return json({ me: { name: user.name, summary: user.summary }, family, forMe, stickers, now }, 200, h);
  }

  if (action === "invite") {
    const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM links WHERE a = ?1 OR b = ?1").bind(me).first()).n;
    if (n >= FAM_MAX) return json({ error: `最多只能連結 ${FAM_MAX} 位家人` }, 400, h);
    await env.DB.prepare("DELETE FROM invites WHERE created < ?").bind(now - 7 * 86400000).run();
    let code = rid(6, CODE_CHARS);
    for (let i = 0; i < 5 && await env.DB.prepare("SELECT code FROM invites WHERE code = ?").bind(code).first(); i++) code = rid(6, CODE_CHARS);   // 避免撞號
    await env.DB.prepare("INSERT INTO invites (code, from_id, type, created) VALUES (?, ?, ?, ?)").bind(code, me, b.type === "care" ? "care" : "mutual", now).run();
    return json({ code }, 200, h);
  }

  if (action === "accept") {
    const code = String(b.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const inv = await env.DB.prepare("SELECT * FROM invites WHERE code = ?").bind(code).first();
    if (!inv || now - inv.created > 7 * 86400000) return json({ error: "邀請碼不存在或已過期" }, 404, h);
    if (inv.from_id === me) return json({ error: "這是你自己發出的邀請喔" }, 400, h);
    const dup = await env.DB.prepare("SELECT id FROM links WHERE (a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1)").bind(inv.from_id, me).first();
    if (dup) { await env.DB.prepare("DELETE FROM invites WHERE code = ?").bind(code).run(); return json({ error: "你們已經是家人了" }, 400, h); }
    for (const who of [me, inv.from_id]) {
      const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM links WHERE a = ?1 OR b = ?1").bind(who).first()).n;
      if (n >= FAM_MAX) return json({ error: who === me ? `你已經有 ${FAM_MAX} 位家人了` : `對方已經有 ${FAM_MAX} 位家人了` }, 400, h);
    }
    const lid = "l" + rid(12);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO links (id, a, b, type, nick_a, nick_b, created) VALUES (?, ?, ?, ?, '', ?, ?)").bind(lid, inv.from_id, me, inv.type, String(b.nick || "").trim().slice(0, 10), now),
      env.DB.prepare("DELETE FROM invites WHERE code = ?").bind(code)
    ]);
    // 通知邀請的人
    const row = await env.DB.prepare("SELECT * FROM subs WHERE id = ?").bind(inv.from_id).first();
    if (row) await sendPush(JSON.parse(row.sub), { title: `${user.name} 接受了你的邀請 🌱`, body: "到家園幫他取個暱稱吧", tag: "fam" }, env).catch(() => {});
    return json({ ok: true, link: lid }, 200, h);
  }

  const l = await linkOf(b.link);

  if (action === "nick") {
    if (!l) return json({ error: "找不到這位家人" }, 404, h);
    const col = l.a === me ? "nick_a" : "nick_b";
    await env.DB.prepare(`UPDATE links SET ${col} = ? WHERE id = ?`).bind(String(b.nick || "").trim().slice(0, 10), l.id).run();
    return json({ ok: true }, 200, h);
  }

  if (action === "unlink") {
    if (!l) return json({ error: "找不到這位家人" }, 404, h);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM donelog WHERE hid IN (SELECT id FROM assigned WHERE link = ?)").bind(l.id),
      env.DB.prepare("DELETE FROM assigned WHERE link = ?").bind(l.id),
      env.DB.prepare("DELETE FROM stickers WHERE link = ?").bind(l.id),
      env.DB.prepare("DELETE FROM links WHERE id = ?").bind(l.id)
    ]);
    return json({ ok: true }, 200, h);
  }

  if (action === "assign") {
    if (!l || !canManage(l, me)) return json({ error: "你不能幫這位家人設提醒" }, 403, h);
    const to = otherOf(l, me);
    const habit = cleanHabit(b.habit || {});
    if (!habit.name || !habit.days.length || !habit.times.length) return json({ error: "名稱、哪幾天、時間都要填" }, 400, h);
    const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM assigned WHERE to_id = ?").bind(to).first()).n;
    if (n >= ASSIGN_MAX) return json({ error: `一個人最多被設 ${ASSIGN_MAX} 個提醒` }, 400, h);
    const id = "f" + rid(10);
    await env.DB.prepare("INSERT INTO assigned (id, link, from_id, to_id, habit, created) VALUES (?, ?, ?, ?, ?, ?)").bind(id, l.id, me, to, JSON.stringify(habit), now).run();
    const row = await env.DB.prepare("SELECT * FROM subs WHERE id = ?").bind(to).first();
    if (row) {
      const fam = await loadFamily(env);
      await sendPush(JSON.parse(row.sub), { title: `${fam.nickFor(l.id, to)}幫你設了提醒：${habit.emoji ? habit.emoji + " " : ""}${habit.name}`, body: "打開喝水啦就看得到", tag: "fam" }, env).catch(() => {});
    }
    return json({ ok: true, id }, 200, h);
  }

  if (action === "unassign" || action === "pause") {
    const a = await env.DB.prepare("SELECT * FROM assigned WHERE id = ?").bind(String(b.habitId || "")).first();
    if (!a) return json({ error: "找不到這個提醒" }, 404, h);
    if (action === "unassign") {
      if (a.from_id !== me) return json({ error: "只有設這個提醒的人可以刪除" }, 403, h);
      await env.DB.batch([env.DB.prepare("DELETE FROM assigned WHERE id = ?").bind(a.id), env.DB.prepare("DELETE FROM donelog WHERE hid = ?").bind(a.id)]);
    } else {
      if (a.to_id !== me) return json({ error: "只有收到提醒的人可以暫停" }, 403, h);
      await env.DB.prepare("UPDATE assigned SET paused = ? WHERE id = ?").bind(b.paused ? 1 : 0, a.id).run();
    }
    return json({ ok: true }, 200, h);
  }

  // 家人按「我完成啦／喝水啦」或「等等我呀」：通知設提醒的人
  if (action === "report") {
    const a = await env.DB.prepare("SELECT * FROM assigned WHERE id = ?").bind(String(b.habitId || "")).first();
    if (!a || a.to_id !== me) return json({ error: "找不到這個提醒" }, 404, h);
    const lk = await env.DB.prepare("SELECT * FROM links WHERE id = ?").bind(a.link).first();
    if (!lk) return json({ error: "找不到這位家人" }, 404, h);
    let habit = {}; try { habit = JSON.parse(a.habit); } catch (e) {}
    const who = myNickFor(lk, a.from_id) || user.name;   // 設提醒的人怎麼稱呼我
    const label = `${habit.emoji ? habit.emoji + " " : ""}${habit.name || "提醒"}`;
    let msg;
    if (b.kind === "later") {
      const row = await env.DB.prepare("SELECT tz FROM subs WHERE id = ?").bind(me).first();
      const t = localNow(row ? row.tz : "Asia/Taipei");
      const slot = Number.isFinite(Number(b.slot)) ? Number(b.slot) : t.min;
      const until = Math.min(t.min + 30, 1439);
      await env.DB.prepare("UPDATE assigned SET snooze = ? WHERE id = ?").bind(JSON.stringify({ day: t.day, slot, until }), a.id).run();
      msg = { title: `${who}：等等我呀！待會兒馬上做`, body: `${label}・${fmt(until)} 會再提醒一次`, tag: "fam-report" };
    } else {
      const water = /水/.test(habit.name || "");
      msg = { title: `${who}：${water ? "喝水啦！" : "我完成啦！"} ✓`, body: label, tag: "fam-report" };
    }
    const row = await env.DB.prepare("SELECT * FROM subs WHERE id = ?").bind(a.from_id).first();
    if (row) await sendPush(JSON.parse(row.sub), msg, env).catch(() => {});
    return json({ ok: true }, 200, h);
  }

  // 傳貼圖：只要是家人都可以，每人每小時最多 30 張
  if (action === "sticker") {
    if (!l) return json({ error: "找不到這位家人" }, 404, h);
    const st = STICKERS[String(b.sticker || "")];
    if (!st) return json({ error: "沒有這個貼圖" }, 400, h);
    const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM stickers WHERE from_id = ? AND at > ?").bind(me, now - 3600000).first()).n;
    if (n >= 30) return json({ error: "傳太多了，休息一下再傳" }, 429, h);
    const to = otherOf(l, me);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO stickers (link, from_id, to_id, sticker, at) VALUES (?, ?, ?, ?, ?)").bind(l.id, me, to, String(b.sticker), now),
      env.DB.prepare("DELETE FROM stickers WHERE at < ?").bind(now - 30 * 86400000)
    ]);
    const row = await env.DB.prepare("SELECT * FROM subs WHERE id = ?").bind(to).first();
    const who = myNickFor(l, to) || user.name;
    if (row) await sendPush(JSON.parse(row.sub), { title: `${who}傳了貼圖：${st}`, body: "", tag: "sticker" }, env).catch(() => {});
    return json({ ok: true }, 200, h);
  }

  if (action === "poke") {
    if (!l || !canManage(l, me)) return json({ error: "你不能戳這位家人" }, 403, h);
    const col = l.a === me ? "poke_a" : "poke_b";
    const wait = l[col] + 3600000 - now;
    if (wait > 0) return json({ error: `剛戳過了，${Math.ceil(wait / 60000)} 分鐘後再戳`, wait: Math.ceil(wait / 1000) }, 429, h);
    const to = otherOf(l, me);
    const row = await env.DB.prepare("SELECT * FROM subs WHERE id = ?").bind(to).first();
    if (!row) return json({ error: "對方還沒開啟推播，戳不到" }, 400, h);
    // 台詞：優先用我幫他設、今天還沒做的提醒；沒有就用喝水台詞
    const tnow = localNow(row.tz), fam = await loadFamily(env);
    const pending = (fam.byFrom[me] || []).filter(a => a.link === l.id && !a.paused && habitDueToday(a.habit, row, tnow).some(m => !doneToday(row, a.id, tnow.day).includes(m)));
    const plant = plantOf(row);
    let line;
    if (pending.length) {
      const a = pick(pending), own = (a.habit.lines && a.habit.lines.remind) || [];
      line = pick(own.length ? own : LINES.habit.remind).replace(/\{item\}/g, a.habit.name);
    } else {
      line = pick(activeLines(await getPool(), "remind", tnow.day));
    }
    line = line.replace(/\{name\}/g, plant.plantName).replace("{owe}", plant.owe).replace("{next}", "等一下");
    await env.DB.prepare(`UPDATE links SET ${col} = ? WHERE id = ?`).bind(now, l.id).run();
    const res = await sendPush(JSON.parse(row.sub), { title: `${user.name}叫我來催你：${line}`, body: "", tag: "poke" }, env);
    return json({ ok: res.ok }, res.ok ? 200 : 502, h);
  }

  return json({ error: "not found" }, 404, h);
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
    plantName: String(s.plantName || "小芽").slice(0, 8),
    sitOn: !!s.sitOn,
    sitInterval: Math.min(240, Math.max(15, Number(s.sitInterval) || 60)),
    sitStart: t(s.sitStart) || "09:00",
    sitEnd: t(s.sitEnd) || "18:00",
    sitMode: s.sitMode === "custom" ? "custom" : "interval",
    sitTimes: (Array.isArray(s.sitTimes) ? s.sitTimes : []).map(t).filter(Boolean).slice(0, 48),
    sitDays: (Array.isArray(s.sitDays) ? s.sitDays : [0, 1, 2, 3, 4, 5, 6]).map(Number).filter(d => d >= 0 && d <= 6),
    habits: (Array.isArray(s.habits) ? s.habits : []).slice(0, 4).map(h => ({
      id: String(h.id || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 24),
      name: String(h.name || "").slice(0, 10),
      emoji: String(h.emoji || "📌").slice(0, 4),
      on: h.on !== false,
      days: (Array.isArray(h.days) ? h.days : []).map(Number).filter(d => d >= 0 && d <= 6),
      times: (Array.isArray(h.times) ? h.times : []).map(t).filter(Boolean).slice(0, 6),
      lines: Object.fromEntries(["remind", "overdue"].map(c => [c, (h.lines && Array.isArray(h.lines[c]) ? h.lines[c] : []).map(x => String(x).slice(0, 60)).slice(0, 20)]))
    })).filter(h => h.id && h.name)
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
  if (path === "/family/peek") { await ensureTable(env); return familyApi("peek", b, env, h); }   // 邀請連結落地頁，還沒有身分
  if (!okId(b.id)) return json({ error: "bad id" }, 400, h);
  await ensureTable(env);

  if (path === "/sync") {
    const sub = b.sub;
    let host = "";
    try { host = new URL(sub.endpoint).hostname; } catch (e) {}
    if (!sub || !sub.keys || !sub.keys.p256dh || !sub.keys.auth || !String(sub.endpoint).startsWith("https://") || !PUSH_HOSTS.some(r => r.test(host)))
      return json({ error: "bad subscription" }, 400, h);
    const st = b.state || {};
    const hd = {};
    if (st.habitDone && typeof st.habitDone === "object") {
      for (const [k, v] of Object.entries(st.habitDone).slice(0, 14)) {
        if (Array.isArray(v)) hd[String(k).slice(0, 24)] = v.map(x => String(x).slice(0, 20)).slice(0, 12);
      }
    }
    const lh = st.lastHabit && typeof st.lastHabit === "object" ? { id: String(st.lastHabit.id || "").slice(0, 24), at: Number(st.lastHabit.at) || 0 } : null;
    const state = { day: String(st.day || "").slice(0, 10), count: Number(st.count) || 0, lastDrink: Number(st.lastDrink) || 0, habitDone: hd, total: Number(st.total) || 0, lastHabit: lh };
    let tz = String(b.tz || "Asia/Taipei").slice(0, 64);
    try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch (e) { tz = "Asia/Taipei"; }
    await env.DB.prepare(`INSERT INTO subs (id, sub, settings, state, tz, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(id) DO UPDATE SET sub = ?2, settings = ?3, state = ?4, tz = ?5, updated = ?6`)
      .bind(b.id, JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }),
        JSON.stringify(cleanSettings(b.settings)), JSON.stringify(state), tz, Date.now()).run();
    await logAssignedDone(env, b.id, hd);
    return json({ ok: true }, 200, h);
  }

  if (path.startsWith("/family/")) return familyApi(path.slice(8), b, env, h);

  if (path === "/lines") {
    if (!env.AI) return json({ error: "伺服器還沒綁定 Workers AI" }, 503, h);
    const name = String(b.name || "").trim().slice(0, 10);
    if (!name) return json({ error: "缺少習慣名稱" }, 400, h);
    const plant = String(b.plant || "小芽").slice(0, 8);
    // 每台裝置每天最多 10 次
    const today = localNow("Asia/Taipei").day;
    const q = await env.DB.prepare("SELECT day, n FROM gen_quota WHERE id = ?").bind(b.id).first();
    const n = (q && q.day === today) ? Number(q.n) : 0;
    if (n >= 10) return json({ error: "今天的 AI 額度用完了，明天再試" }, 429, h);
    await env.DB.prepare("INSERT INTO gen_quota (id, day, n) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET day = ?2, n = ?3").bind(b.id, today, n + 1).run();
    try {
      const lines = await generateLines(env, name, plant);
      return json(lines, 200, h);
    } catch (e) {
      console.log("AI failed", e && e.message, e && e.detail);
      return json({ error: "AI 暫時沒回應", detail: e && e.detail }, 502, h);
    }
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
