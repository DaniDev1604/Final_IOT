// ============================================================
//  Análisis de datos CSV (Grafana / InfluxDB)
//  Adaptación en JavaScript del panel de Streamlit
// ============================================================
(() => {
  // Nombres que se reconocen como columna de tiempo (Grafana suele exportar como _time o Time)
  const CANDIDATAS_TIEMPO = ["time", "_time", "timestamp", "fecha", "date", "datetime"];
  const MAX_FILAS_TABLA = 500;   // filas máximas que se muestran en las tablas
  const MAX_PUNTOS = 3000;       // puntos máximos por serie en la gráfica
  const PASOS_SLIDER = 1000;

  // Paleta en blanco y gris (las series se distinguen por tono y tipo de trazo)
  const PALETA = [
    { line: "#ffffff", fill: "rgba(255,255,255,.18)", bar: "rgba(255,255,255,.8)", dash: [] },
    { line: "#9aa0c3", fill: "rgba(154,160,195,.18)", bar: "rgba(154,160,195,.8)", dash: [6, 4] },
    { line: "#d0d3e2", fill: "rgba(208,211,226,.12)", bar: "rgba(208,211,226,.55)", dash: [2, 3] },
    { line: "#6b7090", fill: "rgba(107,112,144,.2)", bar: "rgba(107,112,144,.8)", dash: [10, 4, 2, 4] },
  ];

  const $ = (id) => document.getElementById(id);
  const input = $("csvInput");
  const drop = $("dropzone");
  const msg = $("csvMsg");
  const panel = $("analysisPanel");
  if (!input) return;

  let datos = null;
  let chart = null;

  // ============================================================
  //  Utilidades
  // ============================================================
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "—");
  const pad = (n) => String(n).padStart(2, "0");
  const fmtFecha = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const validos = (arr) => arr.filter(Number.isFinite);

  function aNumero(v) {
    if (v === null || v === undefined) return NaN;
    const s = String(v).trim();
    if (s === "") return NaN;
    return Number(s.replace(/,/g, "."));
  }

  function parseFecha(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (!s) return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) {
      // Marca de tiempo epoch (s, ms, µs o ns)
      let n = Number(s);
      if (Math.abs(n) < 1e11) n *= 1000;
      else if (Math.abs(n) > 1e17) n /= 1e6;
      else if (Math.abs(n) > 1e14) n /= 1e3;
      return new Date(n);
    }
    let d = new Date(s);
    if (isNaN(d)) d = new Date(s.replace(" ", "T"));
    return isNaN(d) ? null : d;
  }

  function cuantil(ordenado, q) {
    if (!ordenado.length) return NaN;
    const pos = (ordenado.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return ordenado[lo] + (ordenado[hi] - ordenado[lo]) * (pos - lo);
  }

  function estadisticas(arr) {
    const v = validos(arr);
    const n = v.length;
    if (!n) return { count: 0, mean: NaN, std: NaN, min: NaN, q25: NaN, q50: NaN, q75: NaN, max: NaN, ordenado: [] };
    const mean = v.reduce((a, b) => a + b, 0) / n;
    const std = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : NaN;
    const s = [...v].sort((a, b) => a - b);
    return {
      count: n, mean, std,
      min: s[0], q25: cuantil(s, 0.25), q50: cuantil(s, 0.5), q75: cuantil(s, 0.75), max: s[n - 1],
      ordenado: s,
    };
  }

  function correlacion(a, b) {
    const xs = [], ys = [];
    for (let i = 0; i < a.length; i++) {
      if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { xs.push(a[i]); ys.push(b[i]); }
    }
    const n = xs.length;
    if (n < 2) return NaN;
    const mx = xs.reduce((p, c) => p + c, 0) / n;
    const my = ys.reduce((p, c) => p + c, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx, dy = ys[i] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    const den = Math.sqrt(sxx * syy);
    return den === 0 ? NaN : sxy / den;
  }

  /** Escala una serie a 0–1 para comparar variables con unidades distintas. */
  function normalizar(serie) {
    const s = estadisticas(serie);
    const rango = s.max - s.min || 1;
    return serie.map((x) => (Number.isFinite(x) ? (x - s.min) / rango : NaN));
  }

  function setMensajes(lista) {
    msg.innerHTML = lista.map((m) => `<div class="alert alert-${m.tipo}">${m.html}</div>`).join("");
  }

  function llenarSelect(sel, opciones) {
    sel.innerHTML = opciones.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("");
  }

  // ============================================================
  //  Preparación de datos
  // ============================================================
  /** Detecta la columna de tiempo y las columnas numéricas del CSV. */
  function prepararDatos(crudo, campos) {
    campos = campos.filter((c) => c !== undefined && c !== null && String(c).trim() !== "");

    // 1. Columna de tiempo → eje X ordenado
    const colTiempo = campos.find((c) => CANDIDATAS_TIEMPO.includes(String(c).trim().toLowerCase())) ?? null;
    let filas = crudo.map((r, i) => ({ i, t: null, orig: r }));
    if (colTiempo !== null) {
      filas.forEach((f) => (f.t = parseFecha(f.orig[colTiempo])));
      filas = filas.filter((f) => f.t).sort((a, b) => a.t - b.t);
    }
    filas.forEach((f, k) => (f.pos = k));

    // 2. Columnas de texto que en realidad son números (p. ej. "23,5")
    const otras = campos.filter((c) => c !== colTiempo);
    const variables = [];
    const valores = {};
    for (const c of otras) {
      const nums = filas.map((f) => aNumero(f.orig[c]));
      const noVacios = filas.filter((f) => String(f.orig[c] ?? "").trim() !== "").length;
      const ok = nums.filter(Number.isFinite).length;
      // 3. Variables numéricas disponibles para el análisis
      if (noVacios > 0 && ok / noVacios >= 0.9) {
        variables.push(c);
        valores[c] = nums;
      }
    }
    return { filas, variables, valores, colTiempo, campos: otras };
  }

  const etiquetaX = (f) => (datos.colTiempo !== null ? fmtFecha(f.t) : String(f.i));

  function valorCelda(f, c) {
    if (datos.valores[c]) {
      const v = datos.valores[c][f.pos];
      return Number.isFinite(v) ? String(v) : "";
    }
    return f.orig[c] ?? "";
  }

  function tablaFilas(filas) {
    const cols = datos.campos;
    const head = `<tr><th>${datos.colTiempo !== null ? "Time" : "#"}</th>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>`;
    const body = filas
      .slice(0, MAX_FILAS_TABLA)
      .map((f) => `<tr><td>${esc(etiquetaX(f))}</td>${cols.map((c) => `<td>${esc(valorCelda(f, c))}</td>`).join("")}</tr>`)
      .join("");
    const nota = filas.length > MAX_FILAS_TABLA
      ? `<p class="table-note">Mostrando las primeras ${MAX_FILAS_TABLA} de ${filas.length} filas.</p>`
      : "";
    return `<div class="table-scroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>${nota}`;
  }

  // ============================================================
  //  Carga del archivo
  // ============================================================
  function cargar(file) {
    if (!file) return;
    if (!/\.csv$/i.test(file.name)) {
      setMensajes([{ tipo: "error", html: "El archivo debe tener extensión <code>.csv</code>." }]);
      return;
    }
    $("csvFileName").textContent = file.name;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: "greedy",
      transformHeader: (h) => h.trim(),
      complete: (res) => {
        try { procesar(res); } catch (e) { errorProceso(e); }
      },
      error: errorProceso,
    });
  }

  function errorProceso(e) {
    panel.hidden = true;
    setMensajes([
      { tipo: "error", html: `Error al procesar el archivo: ${esc(e && e.message ? e.message : e)}` },
      { tipo: "info", html: "Asegúrate de haber descargado el CSV correctamente desde el panel Inspect &gt; Data en Grafana." },
    ]);
  }

  function procesar(res) {
    datos = prepararDatos(res.data, res.meta.fields || []);

    if (!datos.variables.length) {
      panel.hidden = true;
      setMensajes([{ tipo: "error", html: "No se encontraron columnas numéricas en el archivo. Verifica el formato de Grafana." }]);
      return;
    }

    const mensajes = [{
      tipo: "success",
      html: `Se detectaron <strong>${datos.variables.length}</strong> variable(s) interactiva(s): ` +
        datos.variables.map((v) => `<code>${esc(v)}</code>`).join(", "),
    }];
    if (datos.colTiempo === null) {
      mensajes.push({ tipo: "info", html: "No se encontró columna de tiempo; se usará el número de lectura del Arduino como eje X." });
    }
    setMensajes(mensajes);

    panel.hidden = false;
    construirVisualizacion();
    construirEstadisticas();
    construirFiltros();
    construirHardware();
  }

  input.addEventListener("change", (e) => cargar(e.target.files[0]));
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("dragging"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("dragging"); })
  );
  drop.addEventListener("drop", (e) => cargar(e.dataTransfer.files[0]));

  // Pestañas
  document.querySelectorAll(".tab-btn").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((x) => x.classList.toggle("active", x === b));
      document.querySelectorAll(".tab-panel").forEach((p) => (p.hidden = p.id !== b.dataset.tab));
      if (b.dataset.tab === "tab-vis" && chart) chart.resize();
    })
  );

  // ============================================================
  //  TAB 1 · Visualización
  // ============================================================
  function construirVisualizacion() {
    const vars = datos.variables;
    const porDefecto = vars.length <= 4 ? vars : vars.slice(0, 2);
    $("varChips").innerHTML = vars
      .map((v) => `<label class="chip"><input type="checkbox" value="${esc(v)}" ${porDefecto.includes(v) ? "checked" : ""}><span>${esc(v)}</span></label>`)
      .join("");
    $("varChips").querySelectorAll("input").forEach((i) => (i.onchange = dibujar));
    $("chartType").onchange = dibujar;
    $("normalizar").onchange = dibujar;

    $("showRaw").checked = false;
    $("rawTable").hidden = true;
    $("rawTable").innerHTML = "";
    $("showRaw").onchange = () => {
      $("rawTable").hidden = !$("showRaw").checked;
      if ($("showRaw").checked) $("rawTable").innerHTML = tablaFilas(datos.filas);
    };
    dibujar();
  }

  function dibujar() {
    const sel = [...$("varChips").querySelectorAll("input:checked")].map((i) => i.value);
    if (chart) { chart.destroy(); chart = null; }

    if (!sel.length) {
      $("chartWarn").hidden = false;
      $("chartBox").hidden = true;
      $("chartNote").textContent = "";
      return;
    }
    $("chartWarn").hidden = true;
    $("chartBox").hidden = false;

    const tipo = $("chartType").value;
    const norm = $("normalizar").checked;
    const n = datos.filas.length;
    const paso = Math.max(1, Math.ceil(n / MAX_PUNTOS));
    const idxs = [];
    for (let i = 0; i < n; i += paso) idxs.push(i);
    $("chartNote").textContent = paso > 1 ? `Se muestra 1 de cada ${paso} lecturas para mantener la gráfica fluida.` : "";

    const labels = idxs.map((i) => etiquetaX(datos.filas[i]));
    const datasets = sel.map((v, k) => {
      const serie = norm ? normalizar(datos.valores[v]) : datos.valores[v];
      const c = PALETA[k % PALETA.length];
      return {
        label: v,
        data: idxs.map((i) => (Number.isFinite(serie[i]) ? serie[i] : null)),
        borderColor: c.line,
        backgroundColor: tipo === "Barra" ? c.bar : tipo === "Área" ? c.fill : c.line,
        borderDash: tipo === "Barra" ? [] : c.dash,
        fill: tipo === "Área" ? "origin" : false,
        pointRadius: 0,
        borderWidth: tipo === "Barra" ? 0 : 1.5,
        tension: 0.2,
        spanGaps: true,
      };
    });

    const ejes = { ticks: { color: "#9aa0c3" }, grid: { color: "rgba(255,255,255,.06)" } };
    chart = new Chart($("chart"), {
      type: tipo === "Barra" ? "bar" : "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { labels: { color: "#e8eaf6" } } },
        scales: {
          x: { ...ejes, ticks: { ...ejes.ticks, maxTicksLimit: 8, maxRotation: 0 } },
          y: ejes,
        },
      },
    });
  }

  // ============================================================
  //  TAB 2 · Estadísticas y Alertas
  // ============================================================
  function construirEstadisticas() {
    const vars = datos.variables;
    const claves = ["mean", "std", "min", "q25", "q50", "q75", "max"];
    const filas = vars.map((v) => {
      const s = estadisticas(datos.valores[v]);
      return `<tr><th>${esc(v)}</th><td>${s.count}</td>${claves.map((k) => `<td>${fmt(s[k], 3)}</td>`).join("")}</tr>`;
    }).join("");
    $("describeTable").innerHTML =
      `<div class="table-scroll"><table><thead><tr><th></th><th>count</th><th>mean</th><th>std</th><th>min</th><th>25%</th><th>50%</th><th>75%</th><th>max</th></tr></thead><tbody>${filas}</tbody></table></div>`;

    llenarSelect($("varStats"), vars);
    $("varStats").onchange = actualizarUmbrales;
    actualizarUmbrales();

    if (vars.length >= 2) {
      $("corrBlock").hidden = false;
      const head = `<tr><th></th>${vars.map((v) => `<th>${esc(v)}</th>`).join("")}</tr>`;
      const body = vars.map((a) =>
        `<tr><th>${esc(a)}</th>${vars.map((b) => `<td>${fmt(correlacion(datos.valores[a], datos.valores[b]), 2)}</td>`).join("")}</tr>`
      ).join("");
      $("corrTable").innerHTML = `<div class="table-scroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
    } else {
      $("corrBlock").hidden = true;
    }
  }

  function actualizarUmbrales() {
    const v = $("varStats").value;
    const serie = validos(datos.valores[v]);
    const s = estadisticas(serie);

    $("mMean").textContent = fmt(s.mean);
    $("mMax").textContent = fmt(s.max);
    $("mMin").textContent = fmt(s.min);
    $("mStd").textContent = fmt(s.std);

    // Identificar si la mano estuvo mucho tiempo fuera de rango
    let sup, inf;
    if (s.max <= 1.5) {          // datos normalizados entre 0 y 1
      sup = 0.8; inf = 0.2;
    } else {                     // datos puros del sensor en centímetros
      sup = cuantil(s.ordenado, 0.8);
      inf = cuantil(s.ordenado, 0.2);
    }
    const fueraRango = serie.filter((x) => x > sup).length;
    const muyCerca = serie.filter((x) => x < inf).length;

    $("umbralInfo").innerHTML =
      `<strong>Análisis de uso para <code>${esc(v)}</code>:</strong> El usuario llevó el sensor al límite superior (${fmt(sup)}) en <strong>${fueraRango}</strong> lecturas, y al límite inferior (${fmt(inf)}) en <strong>${muyCerca}</strong> lecturas.`;
  }

  // ============================================================
  //  TAB 3 · Filtros
  // ============================================================
  function construirFiltros() {
    llenarSelect($("varFiltro"), datos.variables);
    $("varFiltro").onchange = renderFiltro;
    renderFiltro();
  }

  function renderFiltro() {
    const v = $("varFiltro").value;
    const serie = datos.valores[v];
    const s = estadisticas(serie);
    const cont = $("filtroContenido");

    if (s.min === s.max) {
      cont.innerHTML =
        `<div class="alert alert-warning">Todos los valores de <code>${esc(v)}</code> están estáticos en: ${fmt(s.min)}</div>` +
        `<div class="alert alert-info">No hubo variación en este control durante la grabación del CSV.</div>` +
        tablaFilas(datos.filas);
      return;
    }

    cont.innerHTML = `
      <p class="range-label">Filtrar momentos donde <code>${esc(v)}</code> estuvo entre:
        <strong id="rangoTxt"></strong></p>
      <div class="dual-range">
        <div class="dual-track"><div class="dual-fill" id="dualFill"></div></div>
        <input type="range" id="rMin" min="0" max="${PASOS_SLIDER}" step="1" value="0" aria-label="Mínimo" />
        <input type="range" id="rMax" min="0" max="${PASOS_SLIDER}" step="1" value="${PASOS_SLIDER}" aria-label="Máximo" />
      </div>
      <p id="filtroCount"></p>
      <div id="filtroTabla"></div>
      <button class="btn" id="btnDescargar" type="button">↓ Descargar segmento aislado (CSV)</button>`;

    const rMin = $("rMin"), rMax = $("rMax");
    const aValor = (k) => (k >= PASOS_SLIDER ? s.max : k <= 0 ? s.min : s.min + ((s.max - s.min) * k) / PASOS_SLIDER);
    let filtrado = datos.filas;
    let pendiente = false;

    const actualizar = () => {
      pendiente = false;
      const k1 = +rMin.value, k2 = +rMax.value;
      const a = aValor(k1), b = aValor(k2);
      $("rangoTxt").textContent = `${fmt(a)} – ${fmt(b)}`;
      $("dualFill").style.left = `${(k1 / PASOS_SLIDER) * 100}%`;
      $("dualFill").style.width = `${((k2 - k1) / PASOS_SLIDER) * 100}%`;
      filtrado = datos.filas.filter((f) => {
        const x = serie[f.pos];
        return x >= a && x <= b;
      });
      $("filtroCount").innerHTML =
        `<strong>${filtrado.length}</strong> de ${datos.filas.length} registros capturados cumplen esta condición:`;
      $("filtroTabla").innerHTML = tablaFilas(filtrado);
    };
    const programar = () => { if (!pendiente) { pendiente = true; requestAnimationFrame(actualizar); } };

    rMin.addEventListener("input", () => { if (+rMin.value > +rMax.value) rMin.value = rMax.value; programar(); });
    rMax.addEventListener("input", () => { if (+rMax.value < +rMin.value) rMax.value = rMin.value; programar(); });
    $("btnDescargar").addEventListener("click", () => descargarCSV(filtrado, `genesis_filtrado_${v}.csv`));
    actualizar();
  }

  function descargarCSV(filas, nombre) {
    const celda = (x) => {
      const s = String(x ?? "");
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const cols = datos.campos;
    const lineas = [[datos.colTiempo !== null ? "Time" : "", ...cols].map(celda).join(",")];
    filas.forEach((f) => lineas.push([etiquetaX(f), ...cols.map((c) => valorCelda(f, c))].map(celda).join(",")));
    const blob = new Blob([lineas.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ============================================================
  //  TAB 4 · Información del sitio
  // ============================================================
  function construirHardware() {
    let html = `<li><strong>Registros en esta sesión:</strong> ${datos.filas.length} lecturas procesadas</li>`;
    if (datos.colTiempo !== null && datos.filas.length) {
      html += `<li><strong>Hora de inicio:</strong> ${fmtFecha(datos.filas[0].t)}</li>`;
      html += `<li><strong>Hora de fin:</strong> ${fmtFecha(datos.filas[datos.filas.length - 1].t)}</li>`;
    }
    $("sesionInfo").innerHTML = html;
  }
})();
