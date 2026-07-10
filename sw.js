// GestorLotes Campo - Service Worker v3
// v3: red-primero para el app shell (index.html) para que las actualizaciones
// lleguen siempre, en vez de quedar pegado al caché viejo para siempre.
const CACHE_NAME = 'gestorLotes-' + new Date().toISOString().slice(0,16).replace('T','-');

// Rutas relativas (funcionan sin importar el subdirectorio del sitio)
const PRECACHE = [
  './',
  './index.html',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/@turf/turf@6/turf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-solid-900.woff2',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-solid-900.ttf'
];

// Install: cache all resources
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      console.log('[SW] Pre-caching resources');
      return Promise.allSettled(
        PRECACHE.map(function(url) {
          return cache.add(url).catch(function(err) {
            console.warn('[SW] Failed to cache:', url, err);
          });
        })
      );
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// Activate: clean old caches
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) { return key !== CACHE_NAME; })
            .map(function(key) { return caches.delete(key); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// Fetch:
// - index.html / navegación / raíz -> RED PRIMERO (siempre la version mas nueva),
//   con el cache como respaldo solo si no hay conexion.
// - tiles de mapa / satelite -> siempre red, sin cachear.
// - resto de recursos (librerias JS/CSS) -> cache-first, no cambian seguido.
self.addEventListener('fetch', function(event) {
  var url = event.request.url;

  if (event.request.method !== 'GET') return;

  var isAppShell = event.request.mode === 'navigate' ||
                    url.endsWith('/') ||
                    url.endsWith('index.html');

  if (isAppShell) {
    event.respondWith(
      fetch(event.request).then(function(response){
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache){ cache.put(event.request, clone); });
        }
        return response;
      }).catch(function(){
        return caches.match(event.request).then(function(cached){
          return cached || caches.match('./index.html');
        });
      })
    );
    return;
  }

  // Skip map tiles - always fetch fresh (satellite imagery)
  if (url.includes('arcgisonline.com') || url.includes('tile.openstreetmap') ||
      url.includes('google.com/vt') || url.includes('copernicus')) {
    event.respondWith(
      fetch(event.request).catch(function() {
        return caches.match(event.request);
      })
    );
    return;
  }

  // Cache-first para librerias externas (Leaflet, turf, fuentes, etc.)
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      if (cached) return cached;
      return fetch(event.request).then(function(response) {
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(function() {
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
