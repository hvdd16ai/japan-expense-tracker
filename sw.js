const CACHE = 'japan-tracker-v17' // 更新檔案後記得改這個版本號
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png']

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)))
  self.skipWaiting()
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', e => {
  if (e.request.url.includes('generativelanguage.googleapis.com')) return
  if (e.request.url.includes('cdn.jsdelivr.net')) return
  if (e.request.url.includes('firestore.googleapis.com')) return
  if (e.request.url.includes('firebase.googleapis.com')) return
  if (e.request.url.includes('gstatic.com')) return
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  )
})
