// 喝水啦 service worker：離線快取 + 伺服器推播 + 圖示紅點
const CACHE = "hoshuila-v3";
const ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./icon-180.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 只處理自己網站的檔案（推播伺服器的請求不要快取）；網路優先，離線時用快取
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
  );
});

// 伺服器推播：一定要顯示通知（iPhone 規定，沒顯示會被取消推播權限）
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }
  const jobs = [
    self.registration.showNotification(d.title || "喝水啦 💧", {
      body: d.body || "該喝水了！",
      icon: "icon-180.png",
      badge: "icon-180.png",
      tag: "drink",
      renotify: true,
      data: { url: "./" }
    })
  ];
  // 主畫面圖示右上角的紅色數字：還欠幾杯
  if (typeof d.badge === "number" && self.navigator.setAppBadge) {
    jobs.push((d.badge > 0 ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge()).catch(() => {}));
  }
  // App 剛好開著的話，讓畫面上的植物也一起叫
  jobs.push(self.clients.matchAll({ type: "window" }).then(list => list.forEach(c => c.postMessage({ type: "push", body: d.body }))));
  e.waitUntil(Promise.all(jobs));
});

// 點通知 → 回到 App
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const c of list) if ("focus" in c) return c.focus();
      return clients.openWindow("./");
    })
  );
});
