/* ============================================================
   DETECCIÓN SATELITAL — candidatos a vecino por NDVI
   ------------------------------------------------------------
   Reemplaza al módulo "Vecinos" viejo (tabla lotes_proyecto + RPC
   buscar_vecinos_buffer, con las funciones vcDetectar/vcAsignar/etc).
   Ese módulo queda obsoleto — no hace falta borrarlo a mano, este
   script no lo toca, simplemente no lo uses más.

   NO REQUIERE editar el HTML existente: se agrega este único
   <script> al final del body y el módulo inyecta su propio botón
   flotante (🛰️) y su propio panel lateral.

   Requiere, ya presentes en la página ANTES de este <script>:
     - supa                (cliente de Supabase ya conectado)
     - L, turf, map          (Leaflet + Turf + el mapa ya inicializado)
     - LP                    (array de lotes propios)
     - getBuf(cultivo)       (opcional; si no existe, usa 300/1200)
     - ES_ESCRITORIO         (opcional; para saber si estamos en
                              modo desktop o mobile y habilitar o no
                              el paso "confirmar en campo")

   Deploy previo necesario (una sola vez, ver INTEGRACION.md):
     1) Correr candidatos_deteccion.sql en el SQL editor de Supabase.
     2) supabase secrets set SH_CLIENT_ID=... SH_CLIENT_SECRET=...
     3) supabase functions deploy detectar-ndvi
   ============================================================ */
(function () {
  'use strict';

  function getBufSafe(cultivo) {
    if (typeof window.getBuf === 'function') return window.getBuf(cultivo);
    return (cultivo || '').toLowerCase() === 'girasol' ? 1200 : 300;
  }

  // Mobile = donde tiene sentido "confirmar en campo" dibujando el polígono
  // (el flujo de recorrido GPS / dibujo manual + visita solo existe ahí).
  var esMobile = (typeof window.ES_ESCRITORIO !== 'undefined')
    ? !window.ES_ESCRITORIO
    : (typeof window.abrirNuevaPosicion === 'function');

  var lgCandidatos = null;
  var _cache = [];        // últimos candidatos guardados (leídos de Supabase)
  var _preview = [];      // resultado crudo de la última detección (sin guardar todavía)
  var _loteFetchCache = {}; // loteId -> Promise (para no pedir el mismo lote dos veces)

  // Si un candidato apunta a un lote que este dispositivo no tiene cargado
  // en LP (típico: un inspector con otra zona asignada, que solo baja los
  // lotes de su propia zona), lo traemos puntualmente desde Supabase acá,
  // sin depender de que se le saque la restricción de zona a nadie.
  function asegurarLoteEnLP(loteId) {
    if (!loteId) return Promise.resolve(null);
    var existente = (window.LP || []).find(function (l) { return l.id === loteId; });
    if (existente) return Promise.resolve(existente);
    if (_loteFetchCache[loteId]) return _loteFetchCache[loteId];

    var promesa = supa.from('lotes').select('*').eq('id', loteId).single().then(function (res) {
      if (res.error || !res.data) return null;
      var l = res.data;
      var loteMapeado = {
        id: l.id, campo: l.campo, proyecto: l.proyecto, zona: l.zona,
        subzona: l.subzona || null, cultivo: l.cultivo, campana: l.campana, geojson: l.geojson,
      };
      if (!(window.LP || []).find(function (x) { return x.id === l.id; })) {
        window.LP.push(loteMapeado);
      }
      return loteMapeado;
    });
    _loteFetchCache[loteId] = promesa;
    return promesa;
  }

  // ---------- estilos + DOM del panel ----------
  function injectStyles() {
    var css = ''
      + '#ds-fab{position:fixed;z-index:5000;bottom:20px;right:20px;background:#0d4a8f;color:#fff;'
      + 'border:none;border-radius:50%;width:52px;height:52px;box-shadow:0 4px 14px rgba(0,0,0,.4);'
      + 'cursor:pointer;font-size:1.3rem;line-height:1}'
      + '#ds-panel{position:fixed;z-index:5001;right:0;top:0;bottom:0;width:360px;max-width:92vw;'
      + 'background:#fff;box-shadow:-4px 0 24px rgba(0,0,0,.25);transform:translateX(100%);'
      + 'transition:transform .25s;display:flex;flex-direction:column;font-family:Segoe UI,Arial,sans-serif}'
      + '#ds-panel.open{transform:translateX(0)}'
      + '#ds-hdr{background:#003865;color:#fff;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0}'
      + '#ds-body{flex:1;overflow-y:auto;padding:12px}'
      + '.ds-card{border:1px solid #e4e8f0;border-radius:10px;padding:10px 12px;margin-bottom:8px;background:#fafbfc;font-size:.78rem}'
      + '.ds-badge{font-size:.65rem;padding:2px 8px;border-radius:10px;font-weight:800}'
      + '.ds-btn{padding:7px 10px;border:none;border-radius:7px;font-size:.75rem;font-weight:700;cursor:pointer;color:#fff}'
      + '.ds-row{display:flex;gap:6px;margin-top:6px}'
      + '#ds-tabs{display:flex;border-bottom:2px solid #eef0f5;flex-shrink:0}'
      + '.ds-tab{flex:1;padding:9px;border:none;background:#f8f9fc;font-size:.7rem;font-weight:700;cursor:pointer;color:#888}'
      + '.ds-tab.active{color:#00763a;background:#fff;border-bottom:2px solid #00763a}'
      + '#ds-body label{font-size:.72rem;font-weight:700;color:#444;display:block;margin:8px 0 3px}'
      + '#ds-body select,#ds-body input{width:100%;padding:6px 8px;border:1px solid #d0d5e0;border-radius:7px;font-size:.78rem}'
      // En celular el panel lateral tapaba TODA la pantalla (era ancho
      // pensado para escritorio) y no dejaba ver el mapa de fondo mientras
      // se revisaban los candidatos. Acá lo convertimos en una hoja que
      // sube desde abajo, como el resto de los paneles de la app, dejando
      // la parte de arriba de la pantalla libre para ver el mapa.
      + '@media (max-width:900px){'
      + '#ds-panel{right:0;left:0;top:auto;bottom:0;width:100%;max-width:100%;'
      + 'height:62vh;max-height:80vh;border-radius:18px 18px 0 0;'
      + 'transform:translateY(100%);box-shadow:0 -4px 24px rgba(0,0,0,.25)}'
      + '#ds-panel.open{transform:translateY(0)}'
      + '#ds-fab{bottom:150px;left:14px;right:auto}'
      + '}';
    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  function injectDom() {
    var fab = document.createElement('button');
    fab.id = 'ds-fab';
    fab.innerHTML = '<i class="fas fa-satellite-dish"></i>';
    fab.title = 'Detección satelital de vecinos (NDVI)';
    fab.onclick = togglePanel;
    document.body.appendChild(fab);

    var panel = document.createElement('div');
    panel.id = 'ds-panel';
    panel.innerHTML =
      '<div id="ds-hdr"><b>Detección satelital (NDVI)</b>' +
      '<button id="ds-close" style="background:none;border:none;color:#fff;font-size:1.1rem;cursor:pointer">&times;</button></div>' +
      '<div id="ds-tabs">' +
        '<button class="ds-tab active" data-tab="detectar">Detectar</button>' +
        '<button class="ds-tab" data-tab="lista">Candidatos</button>' +
      '</div>' +
      '<div id="ds-body"></div>';
    document.body.appendChild(panel);

    document.getElementById('ds-close').addEventListener('click', function () {
      panel.classList.remove('open');
    });

    panel.querySelectorAll('.ds-tab').forEach(function (b) {
      b.addEventListener('click', function () {
        panel.querySelectorAll('.ds-tab').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        if (b.dataset.tab === 'detectar') renderTabDetectar();
        else renderTabLista();
      });
    });
  }

  function togglePanel() {
    var p = document.getElementById('ds-panel');
    p.classList.toggle('open');
    if (p.classList.contains('open')) renderTabDetectar();
  }

  // ---------- TAB: Detectar ----------
  // Abre el visor de Copernicus (true color / false color / NDVI real,
  // capa por capa) centrado en la geometría dada, para que el coordinador
  // pueda hacer una primera confirmación visual antes de asignar el
  // candidato a un inspector. Misma lógica que tenía la vieja pestaña
  // Satélite (Planet), reconstruida acá para no depender de esa parte del
  // código que se está por eliminar.
  function abrirEnCopernicus(geom, fechaDesde, fechaHasta) {
    try {
      var centro = turf.centroid({ type: 'Feature', geometry: geom });
      var lat = centro.geometry.coordinates[1].toFixed(6);
      var lng = centro.geometry.coordinates[0].toFixed(6);
      var bbox = turf.bbox({ type: 'Feature', geometry: geom });
      var anchoGrados = bbox[2] - bbox[0];
      var zoom = anchoGrados > 0.15 ? 11 : anchoGrados > 0.05 ? 13 : anchoGrados > 0.01 ? 15 : 16;
      var url = 'https://browser.dataspace.copernicus.eu/'
        + '?lat=' + lat + '&lng=' + lng + '&zoom=' + zoom
        + '&datasetId=S2_L2A_CDAS';
      if (fechaDesde && fechaHasta) {
        url += '&fromTime=' + fechaDesde + 'T00:00:00.000Z&toTime=' + fechaHasta + 'T23:59:59.999Z';
      }
      window.open(url, '_blank');
    } catch (e) {
      alert('No se pudo abrir Copernicus: ' + (e.message || e));
    }
  }

  function renderTabDetectar() {
    var body = document.getElementById('ds-body');
    var hoy = new Date().toISOString().substr(0, 10);
    var hace30 = new Date(Date.now() - 30 * 86400000).toISOString().substr(0, 10);

    body.innerHTML =
      '<label>Lote propio</label>' +
      '<input type="text" id="ds-lote-buscar" placeholder="Buscar por proyecto, campo, zona o cultivo..." style="margin-bottom:6px"/>' +
      '<select id="ds-lote"><option value="">-- Elegí un lote --</option></select>' +
      '<label>Fecha desde</label><input type="date" id="ds-desde" value="' + hace30 + '"/>' +
      '<label>Fecha hasta</label><input type="date" id="ds-hasta" value="' + hoy + '"/>' +
      '<label>Umbral NDVI (0-1, más alto = más estricto)</label><input type="number" id="ds-umbral" value="0.35" min="0" max="1" step="0.05"/>' +
      '<div style="font-size:.68rem;color:#888;margin-top:4px">Analiza el anillo alrededor del lote (buffer según cultivo) buscando vegetación activa que no sea la tuya. Calibrá el umbral con casos que ya conozcas.</div>' +
      '<button id="ds-btn-detectar" class="ds-btn" style="width:100%;background:#0d4a8f;margin-top:12px;padding:11px"><i class="fas fa-satellite-dish"></i> Buscar candidatos</button>' +
      '<button id="ds-btn-copernicus" class="ds-btn" style="width:100%;background:#1a6bbf;margin-top:8px;padding:9px"><i class="fas fa-external-link-alt"></i> Ver zona en Copernicus (false color / NDVI)</button>' +
      '<div id="ds-resultado" style="margin-top:12px"></div>';

    document.getElementById('ds-lote-buscar').addEventListener('input', function () {
      renderOpcionesLote(this.value);
    });
    renderOpcionesLote('');

    document.getElementById('ds-btn-detectar').addEventListener('click', ejecutarDeteccion);
    document.getElementById('ds-btn-copernicus').addEventListener('click', function () {
      var loteId = document.getElementById('ds-lote').value;
      var lote = (window.LP || []).find(function (l) { return l.id === loteId; });
      if (!lote) { alert('Elegí un lote primero.'); return; }
      var buf = turf.buffer({ type: 'Feature', geometry: lote.geojson }, getBufSafe(lote.cultivo), { units: 'meters' });
      var desde = document.getElementById('ds-desde').value;
      var hasta = document.getElementById('ds-hasta').value;
      abrirEnCopernicus(buf.geometry, desde, hasta);
    });
  }

  function renderOpcionesLote(filtro) {
    var sel = document.getElementById('ds-lote');
    if (!sel) return;
    var f = (filtro || '').toLowerCase().trim();
    var lista = (window.LP || []).filter(function (l) {
      if (!f) return true;
      var txt = ((l.proyecto || '') + ' ' + (l.campo || '') + ' ' + (l.zona || '') + ' ' + (l.cultivo || '')).toLowerCase();
      return txt.indexOf(f) !== -1;
    }).sort(function (a, b) {
      return (a.proyecto || '').localeCompare(b.proyecto || '');
    });

    var actual = sel.value;
    sel.innerHTML = '<option value="">-- ' + lista.length + ' lote(s) --</option>' +
      lista.map(function (l) {
        return '<option value="' + l.id + '">' + (l.proyecto ? '[' + l.proyecto + '] ' : '') + (l.campo || l.id) + ' - ' + l.cultivo + '</option>';
      }).join('');
    if (lista.some(function (l) { return l.id === actual; })) sel.value = actual;
  }

  async function ejecutarDeteccion() {
    var loteId = document.getElementById('ds-lote').value;
    if (!loteId) { alert('Elegí un lote.'); return; }
    var lote = (window.LP || []).find(function (l) { return l.id === loteId; });
    if (!lote || !lote.geojson) { alert('El lote no tiene geometría cargada.'); return; }

    var desde = document.getElementById('ds-desde').value;
    var hasta = document.getElementById('ds-hasta').value;
    var umbral = parseFloat(document.getElementById('ds-umbral').value) || 0.35;
    var buf = getBufSafe(lote.cultivo);

    var res = document.getElementById('ds-resultado');
    var btn = document.getElementById('ds-btn-detectar');
    btn.disabled = true;
    btn.innerHTML = 'Consultando Sentinel Hub... (puede tardar 40-90s con la grilla fina)';
    res.innerHTML = '';

    try {
      var resp = await supa.functions.invoke('detectar-ndvi', {
        body: {
          lote_geom: lote.geojson,
          buffer_metros: buf,
          fecha_desde: desde,
          fecha_hasta: hasta,
          umbral_ndvi: umbral,
          celdas_objetivo: 120,
        },
      });
      if (resp.error) throw resp.error;
      var data = resp.data;
      if (data.error) throw new Error(data.error);

      _preview = data.candidatos || [];
      pintarPreview(_preview, lote);

      if (!_preview.length) {
        res.innerHTML = '<div style="background:#f0fff5;border:1px solid #b0dcbf;border-radius:8px;padding:10px;font-size:.75rem">' +
          'Sin clusters de vegetación activa por encima del umbral (' + data.celdas_con_dato + '/' + data.celdas_analizadas + ' celdas con dato). ' +
          'Zona limpia, o probá bajar el umbral / ampliar el rango de fechas.</div>';
      } else {
        res.innerHTML = '<div style="font-size:.75rem;font-weight:800;color:#003865;margin-bottom:6px">' +
          _preview.length + ' candidato(s) detectado(s) — revisá en el mapa y elegí cuáles guardar</div>' +
          _preview.map(function (c, i) {
            return '<div class="ds-card" style="border-left:3px solid #1a9b4a">' +
              '<label style="display:flex;align-items:center;gap:7px;font-weight:700;cursor:pointer">' +
              '<input type="checkbox" class="ds-chk-cand" data-i="' + i + '" checked/> Candidato ' + (i + 1) +
              '</label>' +
              '<div style="font-size:.7rem;color:#666;margin-top:3px">NDVI prom: ' + c.ndvi_promedio +
              ' &middot; Área: ' + c.area_ha + ' ha &middot; ' + c.n_celdas + ' celda(s)</div>' +
              '</div>';
          }).join('') +
          '<button id="ds-btn-guardar" class="ds-btn" style="width:100%;background:#00763a;margin-top:8px;padding:10px">' +
          'Guardar seleccionados</button>';
        document.getElementById('ds-btn-guardar').addEventListener('click', function () { guardarSeleccionados(loteId); });
      }
    } catch (ex) {
      res.innerHTML = '<div style="background:#fff0f0;border:1px solid #ffb3b3;border-radius:8px;padding:10px;font-size:.75rem;color:#c00">' +
        '<b>Error:</b> ' + (ex.message || ex) + '</div>';
    }
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-satellite-dish"></i> Buscar candidatos';
  }

  // Rosa para maíz, amarillo claro para girasol — mismo criterio que usaba
  // la herramienta vieja (ArcGIS) que se está dando de baja, para que el
  // equipo no tenga que reaprender la referencia de colores.
  var COLOR_CULTIVO = {
    maiz: { fill: '#ff6fae', border: '#d6417f' },
    girasol: { fill: '#fff59d', border: '#d4c020' },
  };
  function colorPorCultivoDeLote(loteId) {
    var lote = (window.LP || []).find(function (l) { return l.id === loteId; });
    var cult = ((lote && lote.cultivo) || '').toLowerCase();
    return COLOR_CULTIVO[cult] || { fill: '#c0392b', border: '#922b21' };
  }

  function pintarPreview(candidatos, lote) {
    if (!window.map) return;
    if (!lgCandidatos) lgCandidatos = L.layerGroup().addTo(map);
    lgCandidatos.clearLayers();
    try {
      var buf = turf.buffer({ type: 'Feature', geometry: lote.geojson }, getBufSafe(lote.cultivo), { units: 'meters' });
      L.geoJSON(buf, { style: { color: '#0d4a8f', weight: 1.5, dashArray: '6,4', fillOpacity: .05 } }).addTo(lgCandidatos);
      var bb = turf.bbox(buf);
      map.fitBounds([[bb[1], bb[0]], [bb[3], bb[2]]], { padding: [60, 60] });
    } catch (e) {}
    var col = colorPorCultivoDeLote(lote.id);
    candidatos.forEach(function (c, i) {
      L.geoJSON({ type: 'Feature', geometry: c.geojson }, { style: { color: col.border, weight: 2, fillColor: col.fill, fillOpacity: .55 } })
        .bindTooltip('Candidato ' + (i + 1) + ' — NDVI ' + c.ndvi_promedio + ' — ' + c.area_ha + ' ha')
        .addTo(lgCandidatos);
    });
  }

  async function guardarSeleccionados(loteId) {
    var chks = document.querySelectorAll('.ds-chk-cand:checked');
    if (!chks.length) { alert('Elegí al menos uno.'); return; }
    var desde = document.getElementById('ds-desde').value;
    var hasta = document.getElementById('ds-hasta').value;
    var umbral = parseFloat(document.getElementById('ds-umbral').value) || 0.35;

    var userRes = await supa.auth.getUser();
    var uid = userRes.data && userRes.data.user ? userRes.data.user.id : null;

    var filas = Array.from(chks).map(function (chk) {
      var c = _preview[parseInt(chk.dataset.i, 10)];
      return {
        lote_id: loteId,
        geojson: c.geojson,
        ndvi_promedio: c.ndvi_promedio,
        area_ha: c.area_ha,
        n_celdas: c.n_celdas,
        fecha_imagen_desde: desde,
        fecha_imagen_hasta: hasta,
        umbral_usado: umbral,
        fuente: 'sentinel2',
        estado: 'pendiente',
        creado_por: uid,
      };
    });

    var ins = await supa.from('candidatos_deteccion').insert(filas);
    if (ins.error) { alert('No se pudo guardar: ' + ins.error.message); return; }
    alert(filas.length + ' candidato(s) guardado(s) como pendientes.');
    var tabLista = document.querySelector('.ds-tab[data-tab="lista"]');
    if (tabLista) tabLista.click();
  }

  // ---------- TAB: Candidatos guardados ----------
  async function renderTabLista() {
    var body = document.getElementById('ds-body');
    body.innerHTML = '<div style="text-align:center;padding:20px;color:#999">Cargando...</div>';

    var q = await supa.from('candidatos_deteccion')
      .select('*')
      .neq('estado', 'descartado')
      .order('creado_en', { ascending: false });
    if (q.error) { body.innerHTML = 'Error: ' + q.error.message; return; }
    _cache = q.data || [];

    // Trae los lotes que este dispositivo no tenga cargados (candidatos
    // asignados a un inspector de otra zona), antes de armar los nombres.
    var idsUnicos = Array.from(new Set(_cache.map(function (c) { return c.lote_id; }).filter(Boolean)));
    await Promise.all(idsUnicos.map(asegurarLoteEnLP));

    pintarCandidatosGuardados(_cache);
    actualizarBadgeFab();

    if (!_cache.length) {
      body.innerHTML = '<div style="text-align:center;padding:20px;color:#999">Sin candidatos activos</div>';
      return;
    }
    body.innerHTML = _cache.map(function (c) {
      var lote = (window.LP || []).find(function (l) { return l.id === c.lote_id; });
      var nombreLote = lote ? ((lote.proyecto ? '[' + lote.proyecto + '] ' : '') + (lote.campo || lote.id)) : c.lote_id;
      var col = c.estado === 'pendiente' ? '#3b82f6' : c.estado === 'asignado' ? '#f59e0b' : '#10b981';
      var lbl = c.estado === 'pendiente' ? 'PENDIENTE' : c.estado === 'asignado' ? 'ASIGNADO' : 'CONFIRMADO';
      var btnCompartir = '<button class="ds-btn" style="background:#25d366;padding:7px 12px" data-act="compartir" data-id="' + c.id + '" title="Compartir"><i class="fab fa-whatsapp"></i></button>';
      var btnCopernicus = '<button class="ds-btn" style="background:#1a6bbf;padding:7px 12px" data-act="copernicus" data-id="' + c.id + '" title="Ver en Copernicus (false color / NDVI)"><i class="fas fa-external-link-alt"></i></button>';
      var acciones = '';
      if (c.estado === 'pendiente') {
        acciones = '<div class="ds-row">' +
          '<button class="ds-btn" style="flex:1;background:#3b82f6" data-act="asignar" data-id="' + c.id + '">Asignar inspector</button>' +
          btnCopernicus +
          btnCompartir +
          '<button class="ds-btn" style="background:#999" data-act="descartar" data-id="' + c.id + '">Descartar</button>' +
          '</div>';
      } else if (c.estado === 'asignado' && esMobile) {
        acciones = '<div class="ds-row">' +
          '<button class="ds-btn" style="flex:1;background:#10b981" data-act="confirmar" data-id="' + c.id + '">Confirmar en campo</button>' +
          btnCopernicus +
          btnCompartir +
          '<button class="ds-btn" style="background:#999" data-act="descartar" data-id="' + c.id + '">Descartar</button>' +
          '</div>';
      } else if (c.estado === 'asignado') {
        acciones = '<div class="ds-row">' +
          '<span style="flex:1;font-size:.7rem;color:#f59e0b">Esperando confirmación del inspector desde el celular</span>' +
          btnCopernicus +
          btnCompartir +
          '</div>';
      }
      return '<div class="ds-card" style="border-left:3px solid ' + col + '">' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<b style="font-size:.78rem">' + nombreLote + '</b>' +
        '<span class="ds-badge" style="background:' + col + '22;color:' + col + '">' + lbl + '</span></div>' +
        '<div style="font-size:.7rem;color:#666;margin-top:3px">NDVI ' + c.ndvi_promedio + ' &middot; ' + c.area_ha + ' ha' +
        (c.inspector_asignado ? ' &middot; Insp: ' + c.inspector_asignado : '') + '</div>' +
        acciones + '</div>';
    }).join('');

    body.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.dataset.id;
        var act = btn.dataset.act;
        if (act === 'asignar') abrirAsignacion(id);
        else if (act === 'descartar') descartar(id);
        else if (act === 'confirmar') iniciarConfirmacionEnCampo(id);
        else if (act === 'compartir') compartirCandidato(id, btn);
        else if (act === 'copernicus') {
          var cand = _cache.find(function (x) { return x.id === id; });
          if (cand && cand.geojson) abrirEnCopernicus(cand.geojson, cand.fecha_imagen_desde, cand.fecha_imagen_hasta);
        }
      });
    });
  }

  function pintarCandidatosGuardados(lista) {
    if (!window.map) return;
    if (!lgCandidatos) lgCandidatos = L.layerGroup().addTo(map);
    lgCandidatos.clearLayers();
    lista.forEach(function (c) {
      if (!c.geojson) return;
      var col = colorPorCultivoDeLote(c.lote_id);
      L.geoJSON({ type: 'Feature', geometry: c.geojson }, { style: { color: col.border, weight: 2, fillColor: col.fill, fillOpacity: .55 } })
        .bindTooltip((c.estado || '').toUpperCase() + ' · NDVI ' + c.ndvi_promedio)
        .addTo(lgCandidatos);
    });
  }

  // ---------- Asignación: desplegable de inspectores de la misma zona que el lote ----------
  function abrirAsignacion(id) {
    var c = _cache.find(function (x) { return x.id === id; });
    if (!c) return;
    var lote = (window.LP || []).find(function (l) { return l.id === c.lote_id; });
    var zonaLote = lote ? lote.zona : null;

    if (!zonaLote) {
      alert('No se pudo determinar la zona de este lote — no se puede filtrar inspectores. Revisá el lote con el coordinador.');
      return;
    }

    var inspectores = (window.USUARIOS || []).filter(function (u) {
      return u.rol === 'inspector' && u.zona === zonaLote;
    });

    if (!inspectores.length) {
      alert('No hay ningún inspector cargado para la zona "' + zonaLote + '". Agregá uno desde Config → Usuarios antes de asignar.');
      return;
    }

    mostrarSelectorInspector(id, inspectores, zonaLote);
  }

  function mostrarSelectorInspector(candId, inspectores, zona) {
    var existente = document.getElementById('ds-asignar-modal');
    if (existente) existente.remove();

    var modal = document.createElement('div');
    modal.id = 'ds-asignar-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:10001;background:rgba(0,10,20,.7);'
      + 'display:flex;align-items:center;justify-content:center;padding:20px';
    modal.innerHTML =
      '<div style="background:#fff;border-radius:14px;max-width:360px;width:100%;padding:22px 20px;box-shadow:0 30px 90px rgba(0,0,0,.5)">'
      + '<div style="font-weight:800;color:#003865;margin-bottom:4px">Asignar inspector</div>'
      + '<div style="font-size:.72rem;color:#888;margin-bottom:14px">Zona del lote: ' + zona + ' — solo se muestran inspectores de esa zona</div>'
      + '<select id="ds-asignar-select" style="width:100%;padding:9px 10px;border:1px solid #d0d5e0;border-radius:8px;margin-bottom:16px;font-size:.85rem">'
      + inspectores.map(function (i) { return '<option value="' + i.id + '">' + i.nombre + '</option>'; }).join('')
      + '</select>'
      + '<div style="display:flex;gap:8px">'
      + '<button id="ds-asignar-ok" class="ds-btn" style="flex:1;background:#3b82f6">Asignar</button>'
      + '<button id="ds-asignar-cancel" class="ds-btn" style="background:#999">Cancelar</button>'
      + '</div></div>';
    document.body.appendChild(modal);

    document.getElementById('ds-asignar-cancel').addEventListener('click', function () { modal.remove(); });
    document.getElementById('ds-asignar-ok').addEventListener('click', function () {
      var selId = document.getElementById('ds-asignar-select').value;
      var insp = inspectores.find(function (i) { return i.id === selId; });
      modal.remove();
      if (insp) asignar(candId, insp.nombre);
    });
  }

  async function asignar(id, nombre) {
    var upd = await supa.from('candidatos_deteccion').update({
      estado: 'asignado',
      inspector_asignado: nombre,
      asignado_en: new Date().toISOString(),
    }).eq('id', id);
    if (upd.error) { alert('Error al asignar: ' + upd.error.message); return; }
    renderTabLista();
  }

  // Comparte una tarjeta con la info del candidato como imagen, usando el
  // selector nativo del dispositivo (mismo mecanismo que "Compartir ficha"
  // en el historial de posiciones: html2canvas + navigator.share). Deja
  // elegir WhatsApp, Mensajes, lo que sea — no fuerza un solo canal.
  async function compartirCandidato(id, btnEl) {
    var c = _cache.find(function (x) { return x.id === id; });
    if (!c) return;
    if (typeof window.html2canvas !== 'function') {
      alert('No se pudo generar la imagen (falta la librería html2canvas).');
      return;
    }
    var oldHtml = btnEl ? btnEl.innerHTML : null;
    if (btnEl) { btnEl.innerHTML = '...'; btnEl.disabled = true; }

    try {
      var lote = (window.LP || []).find(function (l) { return l.id === c.lote_id; });
      var nombreLote = lote ? ((lote.proyecto ? '[' + lote.proyecto + '] ' : '') + (lote.campo || lote.id)) : c.lote_id;

      var wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;left:-9999px;top:0;width:380px;background:#fff;padding:16px;font-family:Segoe UI,Arial,sans-serif;';
      wrap.innerHTML =
        '<div style="background:#0d4a8f;color:#fff;padding:10px 14px;border-radius:8px;margin-bottom:12px;font-weight:700">' +
        '🛰️ Candidato a verificar (satelital)</div>' +
        '<div style="font-size:.85rem;line-height:2;color:#222">' +
        '<b>Lote:</b> ' + nombreLote + '<br>' +
        '<b>NDVI detectado:</b> ' + c.ndvi_promedio + '<br>' +
        '<b>Área aproximada:</b> ' + c.area_ha + ' ha<br>' +
        (c.fecha_imagen_desde ? '<b>Período analizado:</b> ' + c.fecha_imagen_desde + ' a ' + c.fecha_imagen_hasta + '<br>' : '') +
        (c.inspector_asignado ? '<b>Inspector asignado:</b> ' + c.inspector_asignado + '<br>' : '') +
        '</div>' +
        '<div style="font-size:.72rem;color:#888;margin-top:10px;border-top:1px solid #eee;padding-top:8px">' +
        'Abrí GestorLotes Campo para ver la ubicación exacta y confirmar en el lote.</div>';
      document.body.appendChild(wrap);

      var canvas = await html2canvas(wrap, { backgroundColor: '#ffffff', scale: 2 });
      document.body.removeChild(wrap);

      canvas.toBlob(async function (blob) {
        if (btnEl) { btnEl.innerHTML = oldHtml; btnEl.disabled = false; }
        if (!blob) return;
        var file = new File([blob], 'candidato_satelital.png', { type: 'image/png' });

        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
          try { await navigator.share({ files: [file], title: 'Candidato a verificar' }); return; }
          catch (e) { return; }
        }
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = 'candidato_satelital.png';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        alert('Tu navegador no permite compartir directo. La imagen se descargó — buscala y compartila desde ahí.');
      }, 'image/png');
    } catch (e) {
      if (btnEl) { btnEl.innerHTML = oldHtml; btnEl.disabled = false; }
      alert('No se pudo generar la imagen. Probá de nuevo.');
    }
  }

  async function descartar(id) {
    if (!confirm('¿Descartar este candidato? (falso positivo)')) return;
    var upd = await supa.from('candidatos_deteccion').update({ estado: 'descartado', resuelto_en: new Date().toISOString() }).eq('id', id);
    if (upd.error) {
      alert('No se pudo descartar: ' + upd.error.message);
      console.error('descartar:', upd.error);
      return;
    }
    renderTabLista();
  }

  // ---------- Confirmación en campo (solo mobile: reusa el flujo existente) ----------
  async function iniciarConfirmacionEnCampo(id) {
    var c = _cache.find(function (x) { return x.id === id; });
    if (!c) return;
    if (!esMobile || typeof window.abrirNuevaPosicion !== 'function') {
      alert('La confirmación en campo se hace desde la app en el celular del inspector.');
      return;
    }

    // Por si el candidato quedó asignado a un inspector de otra zona (que
    // no tiene este lote descargado): lo traemos antes de seguir.
    var lote = await asegurarLoteEnLP(c.lote_id);
    if (!lote) {
      alert('No se pudo encontrar este lote ni siquiera en la nube. Avisá al coordinador — puede que el candidato quedó mal enlazado.');
      return;
    }
    // asegurarLoteEnLP solo agrega el lote a la lista interna — el mapa no
    // se entera solo. Forzamos un redibujado para que el contorno y el
    // buffer del lote se vean antes de mandarte a marcar el polígono real.
    if (typeof window.renderMap === 'function') window.renderMap();

    // El polígono que detecta el satélite es una celda de grilla (un
    // cuadrado aproximado), no el contorno real del cultivo — le damos al
    // inspector la opción de aceptarlo tal cual (más rápido) o dibujarlo
    // él mismo con las herramientas ya existentes de la app (más preciso).
    //
    // OJO: el confirm() va ANTES de tocar el panel 🛰️. Si se cierra el
    // panel (animación CSS) justo antes de un diálogo bloqueante, algunos
    // navegadores de Android dejan la transición a mitad de camino y la
    // pantalla queda "trabada" aunque el resto del código sí haya corrido.
    var usarDetectado = confirm(
      'El polígono detectado por satélite es aproximado (una celda de grilla, no el contorno real).\n\n' +
      'Aceptar = usarlo tal cual (más rápido)\n' +
      'Cancelar = dibujarlo vos mismo caminando o marcándolo a mano (más preciso)'
    );

    var panel = document.getElementById('ds-panel');
    if (panel) panel.classList.remove('open');

    window._candidatoEnConfirmacion = id;

    try {
      if (usarDetectado) {
        // OJO con el orden: abrirNuevaPosicion() llama internamente a
        // resetPosForm(), que pone currentGeom en null. Por eso el geojson
        // del candidato se carga DESPUÉS de llamarla, no antes.
        window.abrirNuevaPosicion(c.lote_id);
        window.currentGeom = c.geojson || null;
        if (typeof window.updateGeomInfo === 'function') window.updateGeomInfo();
        if (typeof window.toast === 'function') {
          window.toast('Candidato cargado — completá la visita y guardá para confirmar');
        }
      } else if (typeof window.abrirLote === 'function') {
        // abrirLote() muestra el lote con los botones "Recorrer GPS" /
        // "Dibujar" ya existentes. _candidatoEnConfirmacion queda seteado,
        // así que al guardar la posición se cierra igual el círculo con el
        // candidato, con el polígono que el inspector haya marcado.
        window.abrirLote(c.lote_id);
        if (typeof window.toast === 'function') {
          window.toast('Elegí "Recorrer GPS" o "Dibujar" para marcar el polígono real');
        }
      }
    } catch (e) {
      alert('No se pudo abrir el lote para confirmar: ' + (e.message || e));
      console.error('iniciarConfirmacionEnCampo:', e);
    }
  }

  // Envolvemos subirAislamiento() (no guardarPosicion) sin modificar el
  // archivo original. Es la función que realmente sabe cuál es el uuid
  // real que le asignó Supabase (ais.remoteId) y que espera a que la
  // subida termine antes de seguir — evita la carrera de leer el id
  // antes de que exista.
  function envolverSubirAislamiento() {
    if (!esMobile || typeof window.subirAislamiento !== 'function' || window._dsSubirAislamientoEnvuelto) return;
    window._dsSubirAislamientoEnvuelto = true;
    var original = window.subirAislamiento;
    window.subirAislamiento = async function (ais, visita) {
      var candId = window._candidatoEnConfirmacion;
      var ret = await original.apply(this, arguments);
      if (candId && ais.remoteId) {
        window._candidatoEnConfirmacion = null;
        supa.from('candidatos_deteccion').update({
          estado: 'confirmado',
          aislamiento_id: ais.remoteId,
          resuelto_en: new Date().toISOString(),
        }).eq('id', candId).then(function (res) {
          if (res.error) console.warn('No se pudo cerrar el candidato en Supabase:', res.error);
        });
      }
      return ret;
    };
  }

  // ---------- Notificación (insignia en el botón flotante) ----------
  // Le avisa a cualquiera que entre a la app (coordinador o inspector) que
  // hay candidatos asignados esperando confirmación, sin que tenga que
  // abrir el panel para enterarse.
  async function actualizarBadgeFab() {
    var fab = document.getElementById('ds-fab');
    if (!fab) return;
    try {
      var q = await supa.from('candidatos_deteccion').select('id', { count: 'exact', head: true }).eq('estado', 'asignado');
      var n = q.count || 0;
      var badge = document.getElementById('ds-fab-badge');
      if (n > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.id = 'ds-fab-badge';
          badge.style.cssText = 'position:absolute;top:-3px;right:-3px;background:#ef4444;color:#fff;' +
            'border-radius:10px;min-width:19px;height:19px;font-size:.65rem;font-weight:800;' +
            'display:flex;align-items:center;justify-content:center;padding:0 4px;border:2px solid #fff';
          fab.appendChild(badge);
        }
        badge.textContent = n > 99 ? '99+' : n;
        badge.style.display = 'flex';
      } else if (badge) {
        badge.style.display = 'none';
      }
    } catch (e) { /* si falla, simplemente no mostramos la insignia */ }
  }

  // ---------- init ----------
  function init() {
    injectStyles();
    injectDom();
    envolverSubirAislamiento();
    setTimeout(actualizarBadgeFab, 1500); // dar tiempo a que termine el login
    setInterval(actualizarBadgeFab, 180000); // refrescar cada 3 min
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
