/*
 * RFIs · app web de Lápiz de Sueños para varios proyectos (Vercel + Supabase)
 * - Acceso: Supabase Auth con enlace por correo, solo para usuarios invitados.
 * - Permisos: los decide la base por rol (admin, residente, director = Interventoría, consulta,
 *   contratista = solo su especialidad). La app solo oculta botones; aunque alguien los forzara,
 *   la base rechaza lo que su rol no permite (RLS). Marco normativo: Taller 8 · v0.8.
 * - Cálculos: los días los calcula la base (vista v_registro_mora) o este código a partir de
 *   fechas registradas. Ninguna cifra sale de texto escrito por una IA.
 * - Trazabilidad: cada cambio queda en auditoria_eventos con el usuario que lo hizo.
 */
(function () {
  "use strict";
  const cfg = window.APP_CONFIG;
  // Demo sin usuario: ?demo (o ?demo=contratista, director, consulta…). Datos ficticios, solo lectura, sin tocar la base.
  const DEMO = new URLSearchParams(location.search).has("demo") && typeof window.crearClienteDemo === "function";
  if (!DEMO && (!window.supabase || !cfg)) {
    document.getElementById("cargando").innerHTML = '<div class="msg err">No se pudo cargar la conexión con la base. Revisa tu internet y recarga la página; si sigue, avisa al administrador.</div><p class="note">Mientras tanto puedes <a href="?demo">ver la demo con datos ficticios</a>.</p>';
    return;
  }
  const sb = DEMO ? window.crearClienteDemo() : window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // p = código del proyecto activo; config = fila del proyecto activo (tolerancia, cese)
  const S = { user: null, perfil: null, esAdmin: false, proyectos: [], miembros: {}, p: null, frentes: [], config: null, filas: [], abierto: null };

  /* ---------- fechas (zona de la obra) ---------- */
  const ZONA = "America/Santo_Domingo";
  function hoyIso() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: ZONA, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }
  const diaNum = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / 864e5); };
  const fmt = (iso) => (iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : "—");
  const fmtHora = (ts) => (ts ? new Intl.DateTimeFormat("es-DO", { timeZone: ZONA, dateStyle: "short", timeStyle: "short" }).format(new Date(ts)) : "—");

  /* ---------- roles ---------- */
  // Rol en el proyecto activo: admin global, o el que tenga asignado en ese proyecto
  const rol = () => (S.esAdmin ? "admin" : S.miembros[S.p]?.rol);
  const misFrentes = () => S.miembros[S.p]?.frentes || [];
  const leer = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const guardar = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } };
  const puede = (...roles) => roles.includes(rol());
  const ETQ_ROL = { admin: "Admin · Residencia", residente: "Residencia de Obra", director: "Interventoría", consulta: "Consulta", contratista: "Contratista" };

  /* ---------- datos personales (regla 2 de la política) ---------- */
  const PATRONES = [
    [/\b\d{3}-?\d{7}-?\d\b/, "un número que parece cédula"],
    [/(?:\+?1[\s.-]?)?\(?\b(?:809|829|849)\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/, "un teléfono"],
    [/\b(salario|salarios|sueldo|sueldos|n[oó]mina)\b/i, "información de salarios"]
  ];
  function datosSensibles(texto) { return PATRONES.filter(([re]) => re.test(texto || "")).map(([, n]) => n); }
  // Devuelve true si se puede guardar. Si hay datos sensibles, avisa y exige un segundo clic.
  function datosOk(textos, boton, salida) {
    const hallados = [...new Set(textos.flatMap(datosSensibles))];
    const firma = textos.join("\u0000");
    if (!hallados.length || boton.dataset.confirmado === firma) { delete boton.dataset.confirmado; return true; }
    boton.dataset.confirmado = firma;
    msg(salida, "warn", `El texto contiene ${hallados.join(", ")}. La política del proyecto prohíbe guardar datos personales que no sean necesarios: bórralos. Si ya lo revisaste y deben quedar, pulsa el botón otra vez.`);
    return false;
  }

  function msg(el, tipo, texto) { $(el).innerHTML = texto ? `<div class="msg ${tipo}">${texto}</div>` : ""; }
  function mostrar(id) {
    ["cargando", "login", "pendiente"].forEach((s) => ($("#" + s).hidden = s !== id));
    $("#app").hidden = id !== "app";
  }

  /* ---------- sesión ---------- */
  async function arrancar() {
    $("#hoy").textContent = fmt(hoyIso());
    if (DEMO) prepararDemo();
    const { data } = await sb.auth.getSession();
    await alCambiarSesion(data.session);
    sb.auth.onAuthStateChange((_e, session) => { alCambiarSesion(session); });
  }

  let sesionActual; // undefined al inicio: la primera llamada siempre decide qué pantalla mostrar
  async function alCambiarSesion(session) {
    const uid = session?.user?.id || null;
    if (uid === sesionActual) return;
    sesionActual = uid;
    if (!session) { S.user = null; S.perfil = null; $("#who").hidden = true; mostrar("login"); return; }
    S.user = session.user;
    mostrar("cargando");
    const { data: perfil, error } = await sb.from("perfiles").select("rol,activo,correo,nombre").eq("id", uid).maybeSingle();
    $("#who").hidden = false;
    $("#who-correo").textContent = session.user.email || "";
    if (error || !perfil || !perfil.activo) { $("#who-rol").textContent = "pendiente"; mostrar("pendiente"); return; }
    S.perfil = perfil;
    S.esAdmin = perfil.rol === "admin";
    const [pr, mi, fr] = await Promise.all([
      sb.from("proyectos").select("*").order("codigo"),
      sb.from("miembros").select("proyecto_codigo,rol,frentes,activo").eq("usuario_id", uid),
      sb.from("frentes_tecnicos").select("codigo,nombre").order("codigo")
    ]);
    S.miembros = Object.fromEntries((mi.data || []).filter((m) => m.activo).map((m) => [m.proyecto_codigo, m]));
    S.proyectos = (pr.data || []).filter((x) => S.esAdmin || S.miembros[x.codigo]);
    S.frentes = fr.data || [];
    if (!S.proyectos.length) {
      $("#who-rol").textContent = "sin proyecto";
      $("#pendiente").innerHTML = `<div class="empty"><strong>Sin proyectos asignados</strong>Tu cuenta está activa, pero todavía no te asignan a ningún proyecto. Pídeselo al administrador y recarga la página.</div>`;
      mostrar("pendiente"); return;
    }
    mostrar("app");
    const pedido = new URLSearchParams(location.search).get("p") || leer("rfis-proyecto");
    await elegirProyecto(S.proyectos.some((x) => x.codigo === pedido) ? pedido : S.proyectos[0].codigo);
  }

  /* ---------- proyecto activo ---------- */
  function pintarSelectorProyecto() {
    $("#sel-proyecto").innerHTML = S.proyectos.map((x) => `<option value="${esc(x.codigo)}"${x.codigo === S.p ? " selected" : ""}>${esc(x.nombre)} (${esc(x.codigo)})${x.activo ? "" : " · inactivo"}</option>`).join("");
    $("#sel-proyecto").disabled = S.proyectos.length < 2;
  }
  $("#sel-proyecto").addEventListener("change", (e) => elegirProyecto(e.target.value));
  async function elegirProyecto(codigo) {
    S.p = codigo; guardar("rfis-proyecto", codigo);
    S.config = S.proyectos.find((x) => x.codigo === codigo);
    S.filas = []; S.abierto = null; $("#detalle").innerHTML = "";
    pintarSelectorProyecto();
    $("#h1-proyecto").textContent = S.config.nombre;
    $("#tol").textContent = S.config.tolerancia_dias;
    $("#n-llave").textContent = "RFI-" + codigo + "-NNN";
    $("#who-rol").textContent = ETQ_ROL[rol()] || rol();
    document.querySelectorAll("nav.tabs button").forEach((b) => {
      const r = b.dataset.roles; b.hidden = r ? !r.split(",").includes(rol()) : false;
    });
    cargarBase();
    irA("matriz");
    contarPendientes();
  }

  $("#form-login").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const correo = $("#login-correo").value.trim(), clave = $("#login-clave").value;
    if (!clave) return enviarEnlace();
    $("#btn-login").disabled = true; msg("#login-msg", "", "");
    const { error } = await sb.auth.signInWithPassword({ email: correo, password: clave });
    $("#btn-login").disabled = false;
    if (error) msg("#login-msg", "err", /invalid/i.test(error.message)
      ? "Correo o contraseña incorrectos. Si no has creado tu contraseña, pide un enlace de acceso."
      : "No se pudo entrar: " + esc(error.message));
  });
  $("#btn-enlace").addEventListener("click", enviarEnlace);
  async function enviarEnlace() {
    const correo = $("#login-correo").value.trim();
    if (!correo) return msg("#login-msg", "warn", "Escribe tu correo.");
    $("#btn-enlace").disabled = true; msg("#login-msg", "", "");
    const { error } = await sb.auth.signInWithOtp({ email: correo, options: { shouldCreateUser: false, emailRedirectTo: location.origin } });
    $("#btn-enlace").disabled = false;
    if (!error) return msg("#login-msg", "ok", "Listo. Revisa tu correo y abre el enlace en este mismo navegador. El enlace sirve una sola vez.");
    if (/rate limit/i.test(error.message)) return msg("#login-msg", "warn", "Se alcanzó el límite de correos por hora del servicio. Espera un rato y vuelve a intentarlo, o entra con tu contraseña si ya la creaste.");
    msg("#login-msg", "err", /not allowed|signups|not found/i.test(error.message)
      ? "Ese correo no está invitado. Pide acceso al administrador."
      : "No se pudo enviar el enlace: " + esc(error.message));
  }
  $("#btn-salir").addEventListener("click", async () => { await sb.auth.signOut(); });
  $("#btn-demo").addEventListener("click", () => { location.href = location.pathname + "?demo"; });

  function prepararDemo() {
    document.title = "DEMO · RFIs · Lápiz de Sueños";
    $("#btn-salir").textContent = "Salir de la demo";
    const banda = $("#demo-banda");
    banda.hidden = false;
    $("#demo-rol").innerHTML = sb.roles.map((r) => `<option value="${r}"${r === sb.rolDemo() ? " selected" : ""}>${esc(ETQ_ROL[r])}</option>`).join("");
    $("#demo-rol").addEventListener("change", (e) => { location.href = location.pathname + "?demo=" + encodeURIComponent(e.target.value); });
  }

  /* ---------- navegación ---------- */
  document.querySelectorAll("nav.tabs button").forEach((b) => b.addEventListener("click", () => irA(b.dataset.tab)));
  function irA(t) {
    document.querySelectorAll("nav.tabs button").forEach((x) => x.setAttribute("aria-selected", x.dataset.tab === t));
    document.querySelectorAll("#app section.tab").forEach((s) => (s.hidden = s.id !== t));
    if (t === "matriz") cargarMatriz();
    if (t === "auditoria") cargarAuditoria();
    if (t === "cambios") cargarCambios();
    if (t === "usuarios") cargarUsuarios();
    if (t === "proyectos") cargarProyectos();
    if (t === "ajustes") pintarAjustes();
  }

  /* ---------- datos base ---------- */
  function cargarBase() {
    const visibles = puede("contratista") ? S.frentes.filter((f) => misFrentes().includes(f.codigo)) : S.frentes;
    $("#f-frente").innerHTML = `<option value="">${puede("contratista") ? "Mis especialidades" : "Todos los frentes"}</option>` + visibles.map((f) => `<option value="${esc(f.codigo)}">${esc(f.codigo)} · ${esc(f.nombre)}</option>`).join("");
    const opts = S.frentes.map((f) => `<option value="${esc(f.codigo)}">${esc(f.codigo)} · ${esc(f.nombre)}</option>`).join("");
    $("#n-frente").innerHTML = `<option value="">Elige el frente</option>` + opts;
  }
  const nombreFrente = (c) => S.frentes.find((f) => f.codigo === c)?.nombre || c;

  /* ---------- matriz ---------- */
  ["#f-estado", "#f-frente", "#f-ruta"].forEach((s) => $(s).addEventListener("change", pintarMatriz));

  async function cargarMatriz() {
    $("#tabla").innerHTML = `<div class="empty"><span class="spin"></span><br>Cargando la matriz…</div>`;
    const p = S.p;
    const { data, error } = await sb.from("v_registro_mora").select("*").eq("proyecto_codigo", p).order("id");
    if (p !== S.p) return; // cambiaron de proyecto mientras cargaba
    if (error) { $("#tabla").innerHTML = ""; msg("#matriz-msg", "err", "No se pudo leer la matriz: " + esc(error.message) + ". Recarga la página; si sigue, avisa al administrador."); return; }
    msg("#matriz-msg", "", "");
    S.filas = data || [];
    pintarMatriz();
  }

  function moraTrasPlazo(f) { return f.dias_mora == null ? null : Math.max(0, f.dias_mora - (S.config?.tolerancia_dias ?? 7)); }
  // Estados con signo y palabra (se leen en impresión blanco y negro)
  const PILL = { vencido: ["red", "▼ Vencido"], por_vencer: ["amber", "● Por vencer"], en_plazo: ["green", "▲ En plazo"], requiere_soporte_oficial: ["amber", "● Requiere soporte oficial"], respondido: ["grey", "✓ Respondido"] };

  function pintarMatriz() {
    const ab = S.filas.filter((f) => f.estado === "abierto");
    const venc = ab.filter((f) => f.estado_mora === "vencido").length;
    const rc = ab.filter((f) => f.ruta_critica).length;
    const conFecha = ab.filter((f) => f.fecha_solicitud_tipo === "dia" && f.fecha_solicitud).sort((a, b) => a.fecha_solicitud.localeCompare(b.fecha_solicitud));
    const viejo = conFecha[0];
    $("#kpis").innerHTML = `
      <div class="kpi"><span class="lbl">RFIs abiertos</span><span class="big">${ab.length}</span><span class="note">${venc} vencidos (más de ${S.config.tolerancia_dias} días)</span></div>
      <div class="kpi"><span class="lbl">En ruta crítica</span><span class="big">${rc}</span><span class="note">abiertos y marcados como ruta crítica</span></div>
      <div class="kpi"><span class="lbl">Más antiguo</span><span class="big">${viejo ? fmt(viejo.fecha_solicitud) : "—"}</span><span class="note">${viejo ? esc(viejo.id) + " · " + viejo.dias_mora + " días desde la solicitud" : "sin fechas exactas"}</span></div>`;

    const est = $("#f-estado").value, fr = $("#f-frente").value, soloRc = $("#f-ruta").checked;
    const filas = S.filas.filter((f) => (!est || f.estado === est) && (!fr || f.frente_codigo === fr) && (!soloRc || f.ruta_critica));
    if (!S.filas.length) { $("#tabla").innerHTML = `<div class="empty"><strong>Sin RFIs</strong>${puede("admin", "residente") ? "Registra el primero en Nuevo RFI." : "Todavía no hay RFIs registrados."}</div>`; return; }
    if (!filas.length) { $("#tabla").innerHTML = `<div class="empty"><strong>Ningún RFI con estos filtros</strong>Cambia los filtros de arriba.</div>`; return; }
    $("#tabla").innerHTML = `<div class="tbl-wrap"><table><thead><tr>
      <th>Llave</th><th>Frente</th><th class="req">Requerimiento</th><th>Solicitado</th><th>Días desde solicitud</th><th>Días de mora tras ${S.config.tolerancia_dias}</th><th>Estado</th><th>Ruta crítica</th><th>Reiteraciones</th></tr></thead><tbody>${
      filas.map((f) => {
        const p = PILL[f.estado_mora] || ["grey", f.estado_mora];
        return `<tr class="clic" data-id="${esc(f.id)}"><td><span class="key">${esc(f.id)}</span></td>
          <td><span class="pill grey">${esc(f.frente_codigo)}</span></td>
          <td class="req"><strong>${esc(f.necesidad)}</strong>${f.nivel ? `<br><span class="note">${esc(f.nivel)}</span>` : ""}</td>
          <td class="num">${f.fecha_solicitud_tipo === "dia" ? fmt(f.fecha_solicitud) : f.fecha_solicitud_tipo === "mes" ? "Solo el mes" : "Sin fecha"}</td>
          <td class="num">${f.dias_mora ?? "—"}</td><td class="num">${moraTrasPlazo(f) ?? "—"}</td>
          <td><span class="pill ${p[0]}">${esc(p[1])}</span></td><td>${f.ruta_critica ? "Sí" : "No"}</td><td class="num">${f.reiteraciones}</td></tr>`;
      }).join("")}</tbody></table></div>`;
    document.querySelectorAll("#tabla tr.clic").forEach((tr) => tr.addEventListener("click", () => abrirDetalle(tr.dataset.id)));
  }

  /* ---------- detalle de un RFI ---------- */
  async function abrirDetalle(id) {
    S.abierto = id;
    $("#detalle").innerHTML = `<div class="card panel"><span class="spin"></span> Abriendo ${esc(id)}…</div>`;
    const verCambios = puede("admin", "residente", "director");
    if (verCambios) await cargarCorreos();
    const [r, b, c] = await Promise.all([
      sb.from("rfis").select("*").eq("id", id).single(),
      sb.from("rfi_seguimientos").select("tipo,texto,registrado_en,registrado_por").eq("rfi_id", id).order("registrado_en"),
      verCambios ? sb.from("rfi_cambios").select("*").eq("rfi_id", id).order("id", { ascending: false }) : Promise.resolve({ data: [] })
    ]);
    if (r.error) { $("#detalle").innerHTML = `<div class="msg err">No se pudo abrir ${esc(id)}: ${esc(r.error.message)}</div>`; return; }
    pintarDetalle(r.data, b.data || [], c.data || []);
    $("#detalle").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function pintarDetalle(x, bit, cambios) {
    const fila = S.filas.find((f) => f.id === x.id) || {};
    const editar = puede("admin", "residente");
    const opcFrentes = S.frentes.map((f) => `<option value="${esc(f.codigo)}"${f.codigo === x.frente_codigo ? " selected" : ""}>${esc(f.codigo)} · ${esc(f.nombre)}</option>`).join("");
    const etiquetaTipo = { registro_inicial: "Registro inicial", reiteracion: "Reiteración", respuesta: "Respuesta técnica", cambio: "Cambio de datos", observacion: "Observación de Interventoría" };
    const bitHtml = puede("admin", "residente", "director", "contratista")
      ? (puede("contratista") ? `<div class="note">Ves solo respuestas técnicas y observaciones; los correos del cliente son de uso interno.</div>` : "") +
        (bit.length ? `<ol class="bitacora">${bit.map((s) => `<li><span class="lbl">${esc(etiquetaTipo[s.tipo] || s.tipo)} · ${esc(fmtHora(s.registrado_en))}</span><div>${esc(s.texto)}</div></li>`).join("")}</ol>` : `<div class="note">Sin entradas.</div>`)
      : `<div class="note">Tu rol no ve la bitácora (contiene correos de terceros).</div>`;
    const abierto = x.estado === "abierto";
    const notaHtml = puede("contratista") && abierto
      ? `<div class="seccion"><h3>Respuesta técnica</h3>
         <label class="field" for="d-nota"><span class="lbl">Tu respuesta a este requerimiento (queda con tu usuario y la hora)</span><textarea id="d-nota" style="min-height:64px"></textarea></label>
         <div class="row"><button class="btn small" type="button" id="d-btn-nota" data-tipo="respuesta">Registrar respuesta</button></div>
         <p class="note">La Residencia revisa tu respuesta y es quien marca el RFI como respondido.</p></div>`
      : puede("director")
      ? `<div class="seccion"><h3>Observación o validación</h3>
         <label class="field" for="d-nota"><span class="lbl">Observación de Interventoría sobre este RFI</span><textarea id="d-nota" style="min-height:64px"></textarea></label>
         <div class="row"><button class="btn small" type="button" id="d-btn-nota" data-tipo="observacion">Registrar observación</button></div></div>`
      : "";
    const cambiosHtml = puede("admin", "residente", "director")
      ? `<div class="seccion"><h3>Solicitudes de cambio</h3>
         ${cambios.length ? `<div id="d-cambios">${cambios.map(htmlCambio).join("")}</div>` : `<div class="note">Sin solicitudes.</div>`}
         ${puede("admin", "residente") ? `
         <label class="field" for="d-cambio"><span class="lbl">Proponer un cambio (especificación, alcance o diseño)</span><textarea id="d-cambio" style="min-height:56px"></textarea></label>
         <label class="check" for="d-mayor"><input type="checkbox" id="d-mayor"> Cambio mayor: lo aprueba la Interventoría / Dirección de Obra</label>
         <div class="row"><button class="btn small ghost" type="button" id="d-btn-cambio">Enviar a aprobación</button></div>` : ""}</div>`
      : "";

    $("#detalle").innerHTML = `<div class="card panel">
      <div class="rfi-head"><span class="key">${esc(x.id)}</span><button class="btn small ghost" type="button" id="d-cerrar-panel">Cerrar</button></div>
      <h3>${esc(nombreFrente(x.frente_codigo))}${x.nivel ? " · " + esc(x.nivel) : ""}</h3>
      <div>${esc(x.necesidad)}</div>
      <div class="calc">
        <div>Solicitado</div><div class="num">${x.fecha_solicitud_tipo === "dia" ? fmt(x.fecha_solicitud) : x.fecha_solicitud_tipo === "mes" ? "Solo el mes: requiere soporte oficial" : "Sin fecha"}</div>
        <div>Días desde solicitud</div><div class="num">${fila.dias_mora ?? "—"}</div>
        <div>Días de mora tras ${S.config.tolerancia_dias}</div><div class="num">${moraTrasPlazo(fila) ?? "—"}</div>
        <div>Carta enviada</div><div>${x.carta_aprobada_en ? esc(fmtHora(x.carta_aprobada_en)) : "No"}</div>
        <div>Estado</div><div>${x.estado === "cerrado" ? "Respondido el " + fmt(x.fecha_respuesta) : "Abierto"}</div>
      </div>
      <h3>Bitácora</h3>${bitHtml}
      ${notaHtml}
      ${cambiosHtml}
      ${editar ? `
      <h3>Agregar reiteración</h3>
      <label class="field" for="d-reit"><span class="lbl">Texto del nuevo mensaje sobre este mismo requerimiento</span><textarea id="d-reit" style="min-height:64px"></textarea></label>
      <div class="row"><button class="btn small" type="button" id="d-btn-reit">Agregar a la bitácora</button></div>
      <h3>Editar datos</h3>
      <div class="grid2">
        <label class="field" for="d-frente"><span class="lbl">Frente</span><select id="d-frente">${opcFrentes}</select></label>
        <label class="field" for="d-nivel"><span class="lbl">Nivel</span><input id="d-nivel" value="${esc(x.nivel || "")}"></label>
      </div>
      <label class="field" for="d-necesidad"><span class="lbl">Qué falta</span><textarea id="d-necesidad" style="min-height:56px">${esc(x.necesidad)}</textarea></label>
      <div class="grid2">
        <label class="field" for="d-tipo"><span class="lbl">Fecha de solicitud</span><select id="d-tipo">
          <option value="dia"${x.fecha_solicitud_tipo === "dia" ? " selected" : ""}>Día exacto</option>
          <option value="mes"${x.fecha_solicitud_tipo === "mes" ? " selected" : ""}>Solo el mes</option>
          <option value="ninguna"${x.fecha_solicitud_tipo === "ninguna" ? " selected" : ""}>No se sabe</option></select></label>
        <label class="field" for="d-fecha"><span class="lbl">Fecha (para "solo el mes", cualquier día de ese mes)</span><input id="d-fecha" type="date" value="${esc(x.fecha_solicitud || "")}"></label>
      </div>
      <div class="row">
        <label class="check" for="d-detiene"><input type="checkbox" id="d-detiene"${x.detiene_cuadrilla ? " checked" : ""}> Detiene cuadrilla</label>
        <label class="check" for="d-ruta"><input type="checkbox" id="d-ruta"${x.ruta_critica ? " checked" : ""}> Ruta crítica</label>
      </div>
      <div class="row"><button class="btn small" type="button" id="d-btn-guardar">Guardar cambios</button></div>
      ${x.carta_aprobada_en ? "" : `<h3>Carta formal</h3>
      <label class="check" for="d-revise"><input type="checkbox" id="d-revise"> Revisé la carta completa y la apruebo como Residencia de Obra. Si se hizo con IA, lleva la leyenda «Elaborado con asistencia de IA y verificado por la Residencia de Obra».</label>
      <div class="row"><button class="btn small ghost" type="button" id="d-btn-carta">Registrar carta aprobada y enviada hoy</button></div>`}
      <h3>Estado</h3>
      ${x.estado === "abierto"
        ? `<div class="row"><label class="field" for="d-fresp"><span class="lbl">Fecha de respuesta del cliente</span><input id="d-fresp" type="date" value="${hoyIso()}"></label>
           <button class="btn small ghost" type="button" id="d-btn-cerrar">Marcar respondido</button></div>`
        : `<div class="row"><button class="btn small ghost" type="button" id="d-btn-reabrir">Reabrir</button></div>`}
      ` : ""}
      <div id="d-msg"></div>
    </div>`;

    $("#d-cerrar-panel").onclick = () => { $("#detalle").innerHTML = ""; S.abierto = null; };
    enlazarDecisiones($("#detalle"), () => refrescar(x.id, "Decisión registrada. Quedó en la auditoría con tu usuario."));
    if ($("#d-btn-nota")) $("#d-btn-nota").onclick = async () => {
      const t = $("#d-nota").value.trim(), boton = $("#d-btn-nota");
      if (!t) return msg("#d-msg", "warn", "Escribe el texto antes de registrarlo.");
      if (!datosOk([t], boton, "#d-msg")) return;
      const { data, error } = await sb.rpc("agregar_nota", { p_rfi: x.id, p_tipo: boton.dataset.tipo, p_texto: t });
      if (error) return msg("#d-msg", "err", "No se registró: " + esc(error.message));
      if (data === "duplicado") return msg("#d-msg", "warn", "Ese mismo texto ya estaba registrado. No se duplicó.");
      await refrescar(x.id, boton.dataset.tipo === "respuesta" ? "Respuesta registrada. La Residencia la revisará." : "Observación registrada.");
    };
    if ($("#d-btn-cambio")) $("#d-btn-cambio").onclick = async () => {
      const t = $("#d-cambio").value.trim(), boton = $("#d-btn-cambio");
      if (!t) return msg("#d-msg", "warn", "Describe el cambio antes de enviarlo.");
      if (!datosOk([t], boton, "#d-msg")) return;
      const mayor = $("#d-mayor").checked;
      const { error } = await sb.from("rfi_cambios").insert({ rfi_id: x.id, descripcion: t, mayor });
      if (error) return msg("#d-msg", "err", "No se envió: " + esc(error.message));
      contarPendientes();
      await refrescar(x.id, mayor ? "Cambio mayor enviado. Lo decide la Interventoría." : "Cambio menor enviado. Lo decide la Residencia.");
    };
    if (!editar) return;

    $("#d-btn-reit").onclick = async () => {
      const t = $("#d-reit").value.trim();
      if (!t) return msg("#d-msg", "warn", "Escribe el texto del mensaje antes de agregarlo.");
      if (!datosOk([t], $("#d-btn-reit"), "#d-msg")) return;
      const { data, error } = await sb.rpc("agregar_reiteracion", { p_rfi: x.id, p_texto: t });
      if (error) return msg("#d-msg", "err", "No se pudo agregar: " + esc(error.message));
      if (data === "duplicado") return msg("#d-msg", "warn", "Ese mismo mensaje ya estaba en la bitácora. No se duplicó.");
      await refrescar(x.id, "Reiteración agregada. La llave y la fecha de solicitud no cambian.");
    };
    $("#d-btn-guardar").onclick = async () => {
      const tipo = $("#d-tipo").value;
      let fecha = $("#d-fecha").value || null;
      if (tipo === "ninguna") fecha = null;
      if (tipo === "mes" && fecha) fecha = fecha.slice(0, 8) + "01";
      if (tipo !== "ninguna" && !fecha) return msg("#d-msg", "warn", "Pon la fecha, o elige \"No se sabe\".");
      if (!$("#d-necesidad").value.trim()) return msg("#d-msg", "warn", "\"Qué falta\" no puede quedar vacío.");
      const { error } = await sb.from("rfis").update({
        frente_codigo: $("#d-frente").value, nivel: $("#d-nivel").value.trim() || null,
        necesidad: $("#d-necesidad").value.trim(), fecha_solicitud_tipo: tipo, fecha_solicitud: fecha,
        detiene_cuadrilla: $("#d-detiene").checked, ruta_critica: $("#d-ruta").checked
      }).eq("id", x.id);
      if (error) return msg("#d-msg", "err", "No se guardó: " + esc(error.message));
      await refrescar(x.id, "Cambios guardados. La llave no cambia.");
    };
    if ($("#d-btn-carta")) $("#d-btn-carta").onclick = async () => {
      if (!$("#d-revise").checked) return msg("#d-msg", "warn", "Marca la casilla de revisión: ninguna carta se registra sin que la Residencia la haya revisado.");
      const { error } = await sb.from("rfis").update({ carta_aprobada_en: new Date().toISOString() }).eq("id", x.id);
      if (error) return msg("#d-msg", "err", "No se registró: " + esc(error.message));
      await refrescar(x.id, "Carta registrada como aprobada y enviada hoy.");
    };
    if ($("#d-btn-cerrar")) $("#d-btn-cerrar").onclick = async () => {
      const f = $("#d-fresp").value;
      if (!f) return msg("#d-msg", "warn", "Pon la fecha en que respondió el cliente.");
      const { error } = await sb.from("rfis").update({ estado: "cerrado", fecha_respuesta: f }).eq("id", x.id);
      if (error) return msg("#d-msg", "err", "No se cerró: " + esc(error.message));
      await refrescar(x.id, "RFI marcado como respondido.");
    };
    if ($("#d-btn-reabrir")) $("#d-btn-reabrir").onclick = async () => {
      const { error } = await sb.from("rfis").update({ estado: "abierto", fecha_respuesta: null }).eq("id", x.id);
      if (error) return msg("#d-msg", "err", "No se reabrió: " + esc(error.message));
      await refrescar(x.id, "RFI reabierto.");
    };
  }

  async function refrescar(id, texto) {
    await cargarMatriz();
    await abrirDetalle(id);
    msg("#d-msg", "ok", esc(texto));
  }

  /* ---------- nuevo RFI ---------- */
  $("#n-tipo").addEventListener("change", () => { $("#w-n-fecha").hidden = $("#n-tipo").value === "ninguna"; });
  $("#n-frente").addEventListener("change", () => {
    const fr = $("#n-frente").value;
    const mismos = S.filas.filter((f) => f.estado === "abierto" && f.frente_codigo === fr);
    $("#n-dup").innerHTML = fr && mismos.length
      ? `<div class="msg warn">Ya hay RFIs abiertos de este frente: ${mismos.map((f) => `<strong>${esc(f.id)}</strong> (${esc(f.necesidad.slice(0, 60))})`).join(", ")}. Si es el mismo requerimiento, no crees otro: ábrelo en la Matriz y agrega una reiteración.</div>`
      : "";
  });
  $("#form-nuevo").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const tipo = $("#n-tipo").value;
    let fecha = $("#n-fecha").value || null;
    if (tipo === "ninguna") fecha = null;
    if (tipo === "mes" && fecha) fecha = fecha.slice(0, 8) + "01";
    if (!$("#n-frente").value) return msg("#nuevo-msg", "warn", "Elige el frente.");
    if (tipo !== "ninguna" && !fecha) return msg("#nuevo-msg", "warn", "Pon la fecha de solicitud, o elige \"No se sabe\".");
    const lead = parseInt($("#n-lead").value, 10);
    if (!datosOk([$("#n-necesidad").value, $("#n-origen").value], $("#btn-crear"), "#nuevo-msg")) return;
    $("#btn-crear").disabled = true;
    const { data, error } = await sb.rpc("crear_rfi", {
      p_proyecto: S.p, p_frente: $("#n-frente").value, p_nivel: $("#n-nivel").value, p_necesidad: $("#n-necesidad").value.trim(),
      p_fecha_solicitud: fecha, p_fecha_tipo: tipo,
      p_lead_cantidad: lead > 0 ? lead : null, p_lead_unidad: lead > 0 ? $("#n-lead-u").value : null,
      p_detiene: $("#n-detiene").checked, p_ruta_critica: $("#n-ruta").checked, p_texto_origen: $("#n-origen").value
    });
    $("#btn-crear").disabled = false;
    if (error) return msg("#nuevo-msg", "err", "No se creó: " + esc(error.message));
    $("#form-nuevo").reset(); $("#n-dup").innerHTML = ""; $("#w-n-fecha").hidden = false;
    msg("#nuevo-msg", "ok", `Creado <span class="key">${esc(data)}</span>.`);
    await cargarMatriz();
  });

  /* ---------- solicitudes de cambio ---------- */
  const puedeDecidir = (c) => c.estado === "pendiente" && (c.mayor ? puede("director") : puede("admin", "residente"));
  const PILL_CAMBIO = { pendiente: ["amber", "● Pendiente"], aprobado: ["green", "✓ Aprobado"], rechazado: ["red", "✗ Rechazado"] };
  function htmlCambio(c) {
    const p = PILL_CAMBIO[c.estado] || ["grey", c.estado];
    const quien = (id) => S.correos?.[id] || "otro usuario";
    return `<div class="cambio" data-cambio="${c.id}">
      <div class="row"><span class="key">${esc(c.rfi_id)}</span><span class="pill grey">${c.mayor ? "Mayor · Interventoría" : "Menor · Residencia"}</span><span class="pill ${p[0]}">${p[1]}</span></div>
      <div>${esc(c.descripcion)}</div>
      <div class="note">Propuesto ${esc(fmtHora(c.propuesto_en))}${S.correos ? " por " + esc(quien(c.propuesto_por)) : ""}${c.decidido_en ? ` · Decidido ${esc(fmtHora(c.decidido_en))}${S.correos ? " por " + esc(quien(c.decidido_por)) : ""}${c.nota_decision ? ": " + esc(c.nota_decision) : ""}` : ""}</div>
      ${puedeDecidir(c) ? `<div class="row"><input class="c-nota" placeholder="Nota de la decisión (opcional)" aria-label="Nota de la decisión" style="flex:1 1 200px">
        <button class="btn small" type="button" data-decidir="1">Aprobar</button><button class="btn small ghost" type="button" data-decidir="0">Rechazar</button></div>`
        : c.estado === "pendiente" ? `<div class="note">${c.mayor ? "Espera la decisión de la Interventoría." : "Espera la decisión de la Residencia."}</div>` : ""}
    </div>`;
  }
  function enlazarDecisiones(cont, despues) {
    cont.querySelectorAll("[data-decidir]").forEach((b) => b.addEventListener("click", async () => {
      const caja = b.closest("[data-cambio]");
      const salida = cont.querySelector("#d-msg") ? "#d-msg" : "#cambios-msg";
      const { error } = await sb.rpc("decidir_cambio", { p_id: Number(caja.dataset.cambio), p_aprobar: b.dataset.decidir === "1", p_nota: caja.querySelector(".c-nota").value });
      if (error) return msg(salida, "err", "No se registró la decisión: " + esc(error.message));
      contarPendientes();
      await despues();
    }));
  }
  async function cargarCorreos() {
    if (S.correos || !puede("admin", "director")) return;
    const { data } = await sb.from("perfiles").select("id,correo");
    S.correos = Object.fromEntries((data || []).map((p) => [p.id, p.correo]));
  }
  $("#c-filtro").addEventListener("change", cargarCambios);
  async function cargarCambios() {
    $("#cambios-tabla").innerHTML = `<span class="spin"></span>`;
    await cargarCorreos();
    let q = sb.from("rfi_cambios").select("*").like("rfi_id", "RFI-" + S.p + "-%").order("id", { ascending: false }).limit(200);
    if ($("#c-filtro").value) q = q.eq("estado", $("#c-filtro").value);
    const { data, error } = await q;
    if (error) { $("#cambios-tabla").innerHTML = `<div class="msg err">No se pudieron leer las solicitudes: ${esc(error.message)}</div>`; return; }
    $("#cambios-tabla").innerHTML = data.length ? data.map(htmlCambio).join("") : `<div class="empty"><strong>Sin solicitudes</strong>${$("#c-filtro").value ? "No hay cambios pendientes." : "Todavía no se ha propuesto ningún cambio."}</div>`;
    enlazarDecisiones($("#cambios-tabla"), async () => { await cargarCambios(); msg("#cambios-msg", "ok", "Decisión registrada. Quedó en la auditoría con tu usuario."); });
  }
  async function contarPendientes() {
    if (!puede("admin", "residente", "director")) return;
    const { data } = await sb.from("rfi_cambios").select("id,mayor,estado").like("rfi_id", "RFI-" + S.p + "-%").eq("estado", "pendiente");
    const n = (data || []).filter(puedeDecidir).length;
    $("#n-cambios").hidden = !n; $("#n-cambios").textContent = n;
  }

  /* ---------- auditoría ---------- */
  const TABLAS = ["rfis", "rfi_seguimientos", "rfi_cambios", "responsables", "frentes_tecnicos", "perfiles", "proyectos", "miembros", "levantamiento_medidas", "areas", "muros", "huecos", "elementos_lineales"];
  $("#a-tabla").innerHTML = `<option value="">Todas las tablas</option>` + TABLAS.map((t) => `<option value="${t}">${t}</option>`).join("");
  $("#a-tabla").addEventListener("change", cargarAuditoria);
  $("#a-todo").addEventListener("change", cargarAuditoria);

  async function cargarAuditoria() {
    $("#audit-tabla").innerHTML = `<span class="spin"></span>`;
    $("#w-a-todo").hidden = !S.esAdmin;
    let q = sb.from("auditoria_eventos").select("id,ocurrido_en,usuario_correo,rol,origen,tabla,operacion,llave,campos_cambiados,proyecto_codigo").order("id", { ascending: false }).limit(200);
    if ($("#a-tabla").value) q = q.eq("tabla", $("#a-tabla").value);
    if (!(S.esAdmin && $("#a-todo").checked)) q = q.eq("proyecto_codigo", S.p);
    const { data, error } = await q;
    if (error) { $("#audit-tabla").innerHTML = `<div class="msg err">No se pudo leer la auditoría: ${esc(error.message)}</div>`; return; }
    $("#audit-tabla").innerHTML = !data.length ? `<div class="empty"><strong>Sin eventos</strong>Todavía no hay cambios registrados para este filtro.</div>` :
      `<div class="tbl-wrap"><table><thead><tr><th>Fecha</th><th>Quién</th><th>Origen</th><th>Proyecto</th><th>Tabla</th><th>Operación</th><th>Registro</th><th>Campos</th></tr></thead><tbody>${
        data.map((e) => `<tr><td class="num">${esc(fmtHora(e.ocurrido_en))}</td><td>${esc(e.usuario_correo || "—")}${e.rol ? `<br><span class="note">${esc(e.rol)}</span>` : ""}</td>
          <td class="wrap note">${esc(e.origen)}</td><td class="mono">${esc(e.proyecto_codigo || "general")}</td><td class="mono">${esc(e.tabla)}</td><td>${esc(e.operacion)}</td><td class="mono">${esc(e.llave || "—")}</td>
          <td class="wrap mono">${esc((e.campos_cambiados || []).join(", ") || "—")}</td></tr>`).join("")}</tbody></table></div>`;
    const ac = await sb.rpc("accesos_recientes", { limite: 100 });
    $("#accesos-tabla").innerHTML = ac.error ? `<div class="msg err">No se pudieron leer los accesos: ${esc(ac.error.message)}</div>` :
      !ac.data.length ? `<div class="note">Sin accesos registrados.</div>` :
      `<div class="tbl-wrap"><table><thead><tr><th>Fecha</th><th>Acción</th><th>Usuario</th><th>IP</th></tr></thead><tbody>${
        ac.data.map((a) => `<tr><td class="num">${esc(fmtHora(a.ocurrido_en))}</td><td>${esc(a.accion)}</td><td>${esc(a.usuario || "—")}</td><td class="mono">${esc(a.ip || "—")}</td></tr>`).join("")}</tbody></table></div>`;
  }

  /* ---------- usuarios ---------- */
  async function cargarUsuarios() {
    $("#u-proy").textContent = S.config.nombre;
    const [pf, mi] = await Promise.all([
      sb.from("perfiles").select("id,correo,nombre,rol,activo,creado_en").order("creado_en"),
      sb.from("miembros").select("usuario_id,rol,frentes,activo").eq("proyecto_codigo", S.p)
    ]);
    if (pf.error) { $("#usuarios-tabla").innerHTML = `<div class="msg err">${esc(pf.error.message)}</div>`; return; }
    const m = Object.fromEntries((mi.data || []).map((x) => [x.usuario_id, x]));
    const ROLES_P = ["residente", "director", "consulta", "contratista"];
    $("#usuarios-tabla").innerHTML = `<div class="tbl-wrap"><table><thead><tr><th>Correo</th><th>Nombre</th><th>Cuenta activa</th><th>Admin de todo</th><th>Rol en ${esc(S.p)}</th><th>Especialidad (contratista)</th><th></th></tr></thead><tbody>${
      pf.data.map((u) => {
        const mm = m[u.id] && m[u.id].activo ? m[u.id] : null;
        return `<tr data-id="${esc(u.id)}"><td>${esc(u.correo)}</td><td><input class="u-nombre" value="${esc(u.nombre || "")}" aria-label="Nombre"></td>
        <td><input type="checkbox" class="u-activo" aria-label="Cuenta activa"${u.activo ? " checked" : ""}></td>
        <td><input type="checkbox" class="u-admin" aria-label="Admin de todos los proyectos"${u.rol === "admin" ? " checked" : ""}></td>
        <td><select class="u-rol" aria-label="Rol en el proyecto"><option value="">Sin acceso</option>${ROLES_P.map((r) => `<option value="${r}"${mm && mm.rol === r ? " selected" : ""}>${esc(ETQ_ROL[r])}</option>`).join("")}</select></td>
        <td><select class="u-frentes" multiple aria-label="Especialidad">${S.frentes.map((f) => `<option value="${esc(f.codigo)}"${mm && (mm.frentes || []).includes(f.codigo) ? " selected" : ""}>${esc(f.codigo)} · ${esc(f.nombre)}</option>`).join("")}</select></td>
        <td><button class="btn small" type="button">Guardar</button></td></tr>`;
      }).join("")}</tbody></table></div>`;
    document.querySelectorAll("#usuarios-tabla tr[data-id] button").forEach((b) => b.addEventListener("click", async () => {
      const tr = b.closest("tr"), id = tr.dataset.id;
      const activo = tr.querySelector(".u-activo").checked, admin = tr.querySelector(".u-admin").checked;
      const rolP = tr.querySelector(".u-rol").value;
      const frentes = [...tr.querySelector(".u-frentes").selectedOptions].map((o) => o.value);
      if (id === S.user.id && (!admin || !activo)) return msg("#usuarios-msg", "warn", "No puedes quitarte tu propio acceso de admin desde aquí: te quedarías sin esta pantalla.");
      if (rolP === "contratista" && !frentes.length) return msg("#usuarios-msg", "warn", "Elige al menos una especialidad para el contratista (Ctrl o Cmd + clic para varias). Sin ella no vería ningún RFI.");
      const r1 = await sb.from("perfiles").update({ rol: admin ? "admin" : "consulta", activo, nombre: tr.querySelector(".u-nombre").value.trim() || null }).eq("id", id);
      if (r1.error) return msg("#usuarios-msg", "err", "No se guardó la cuenta: " + esc(r1.error.message));
      let r2 = { error: null };
      if (rolP) r2 = await sb.from("miembros").upsert({ usuario_id: id, proyecto_codigo: S.p, rol: rolP, frentes: rolP === "contratista" ? frentes : [], activo: true }, { onConflict: "usuario_id,proyecto_codigo" });
      else if (m[id]) r2 = await sb.from("miembros").update({ activo: false }).eq("usuario_id", id).eq("proyecto_codigo", S.p);
      if (r2.error) return msg("#usuarios-msg", "err", "Se guardó la cuenta, pero no el rol en el proyecto: " + esc(r2.error.message));
      msg("#usuarios-msg", "ok", `Usuario actualizado${rolP ? " con rol " + esc(ETQ_ROL[rolP]) + " en " + esc(S.p) : " sin acceso a " + esc(S.p)}. El cambio quedó en la auditoría.`);
      cargarUsuarios();
    }));
  }

  /* ---------- proyectos (admin) ---------- */
  async function cargarProyectos() {
    const { data, error } = await sb.from("proyectos").select("*").order("codigo");
    if (error) { $("#proyectos-tabla").innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
    S.proyectos = data;
    pintarSelectorProyecto();
    $("#proyectos-tabla").innerHTML = `<div class="tbl-wrap"><table class="corta"><thead><tr><th>Código</th><th>Nombre</th><th>Cliente</th><th>Días de tolerancia</th><th>Activo</th><th></th></tr></thead><tbody>${
      data.map((x) => `<tr data-cod="${esc(x.codigo)}"><td><span class="key">${esc(x.codigo)}</span></td>
        <td><input class="pr-nombre" value="${esc(x.nombre)}" aria-label="Nombre"></td>
        <td><input class="pr-cliente" value="${esc(x.cliente || "")}" aria-label="Cliente"></td>
        <td><input class="pr-tol" type="number" min="1" max="60" value="${x.tolerancia_dias}" aria-label="Días de tolerancia" style="width:90px"></td>
        <td><input type="checkbox" class="pr-activo" aria-label="Activo"${x.activo ? " checked" : ""}></td>
        <td><button class="btn small" type="button">Guardar</button></td></tr>`).join("")}</tbody></table></div>`;
    document.querySelectorAll("#proyectos-tabla tr[data-cod] button").forEach((b) => b.addEventListener("click", async () => {
      const tr = b.closest("tr"), cod = tr.dataset.cod;
      const tol = parseInt(tr.querySelector(".pr-tol").value, 10);
      if (!tr.querySelector(".pr-nombre").value.trim()) return msg("#proyectos-msg", "warn", "El nombre no puede quedar vacío.");
      if (!(tol >= 1 && tol <= 60)) return msg("#proyectos-msg", "warn", "Los días de tolerancia van de 1 a 60.");
      const { error: e } = await sb.from("proyectos").update({ nombre: tr.querySelector(".pr-nombre").value.trim(), cliente: tr.querySelector(".pr-cliente").value.trim() || null, tolerancia_dias: tol, activo: tr.querySelector(".pr-activo").checked }).eq("codigo", cod);
      if (e) return msg("#proyectos-msg", "err", "No se guardó: " + esc(e.message));
      msg("#proyectos-msg", "ok", "Proyecto " + esc(cod) + " actualizado.");
      await cargarProyectos();
      if (cod === S.p) { S.config = S.proyectos.find((x) => x.codigo === cod); $("#h1-proyecto").textContent = S.config.nombre; $("#tol").textContent = S.config.tolerancia_dias; }
    }));
  }
  $("#form-proyecto").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const cod = $("#np-codigo").value.trim().toUpperCase(), nom = $("#np-nombre").value.trim(), tol = parseInt($("#np-tol").value, 10) || 7;
    if (!/^[A-Z0-9]{2,8}$/.test(cod)) return msg("#np-msg", "warn", "El código va de 2 a 8 letras o números, sin espacios (ej. C81). Queda en todas las llaves y no se puede cambiar después.");
    if (!nom) return msg("#np-msg", "warn", "Escribe el nombre del proyecto.");
    if (S.proyectos.some((x) => x.codigo === cod)) return msg("#np-msg", "warn", "Ya existe un proyecto con el código " + esc(cod) + ".");
    const { error } = await sb.from("proyectos").insert({ codigo: cod, nombre: nom, cliente: $("#np-cliente").value.trim() || null, tolerancia_dias: tol });
    if (error) return msg("#np-msg", "err", "No se creó: " + esc(error.message));
    $("#form-proyecto").reset();
    msg("#np-msg", "ok", `Proyecto <span class="key">${esc(cod)}</span> creado. Sus RFIs serán RFI-${esc(cod)}-001, 002… Asigna su equipo en Usuarios después de cambiar a ese proyecto arriba.`);
    await cargarProyectos();
  });

  /* ---------- ajustes ---------- */
  function diasCese(a, b) { return a && b && b >= a ? diaNum(b) - diaNum(a) + 1 : null; }
  function pintarAjustes() {
    const c = S.config || {};
    $("#c-ini").value = c.cese_inicio || ""; $("#c-fin").value = c.cese_fin || ""; $("#c-tol").value = c.tolerancia_dias || 7;
    $("#aj-proy").textContent = c.nombre + " (" + c.codigo + ")";
    const ed = puede("admin", "residente");
    ["#c-ini", "#c-fin", "#c-tol", "#btn-ajustes"].forEach((s) => ($(s).disabled = !ed));
    actualizarDias();
  }
  function actualizarDias() {
    const d = diasCese($("#c-ini").value, $("#c-fin").value);
    $("#c-dias").textContent = d ? `Parálisis por cese: ${d} días calendario (fin − inicio + 1).` : "Con inicio y fin, el código calcula los días calendario de parálisis.";
  }
  ["#c-ini", "#c-fin"].forEach((s) => $(s).addEventListener("input", actualizarDias));
  $("#form-ajustes").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const a = $("#c-ini").value || null, b = $("#c-fin").value || null;
    if (a && b && b < a) return msg("#ajustes-msg", "err", "El fin del cese debe ser igual o posterior al inicio.");
    const tol = parseInt($("#c-tol").value, 10);
    if (!(tol >= 1 && tol <= 60)) return msg("#ajustes-msg", "warn", "Los días de tolerancia van de 1 a 60.");
    const { error } = await sb.from("proyectos").update({ cese_inicio: a, cese_fin: b, tolerancia_dias: tol }).eq("codigo", S.p);
    if (error) return msg("#ajustes-msg", "err", "No se guardó: " + esc(error.message));
    S.config.cese_inicio = a; S.config.cese_fin = b; S.config.tolerancia_dias = tol; $("#tol").textContent = tol;
    msg("#ajustes-msg", "ok", "Guardado.");
  });

  $("#form-clave").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const k1 = $("#k-1").value, k2 = $("#k-2").value;
    if (k1.length < 8) return msg("#clave-msg", "warn", "La contraseña debe tener al menos 8 caracteres.");
    if (k1 !== k2) return msg("#clave-msg", "warn", "Las dos contraseñas no coinciden.");
    $("#btn-clave").disabled = true;
    const { error } = await sb.auth.updateUser({ password: k1 });
    $("#btn-clave").disabled = false;
    if (error) return msg("#clave-msg", "err", "No se guardó: " + esc(error.message));
    $("#form-clave").reset();
    msg("#clave-msg", "ok", "Contraseña guardada. La próxima vez entra con tu correo y esta contraseña.");
  });

  arrancar().catch((e) => {
    document.getElementById("cargando").hidden = false;
    document.getElementById("cargando").innerHTML = '<div class="msg err">No se pudo iniciar la app (' + esc(e && e.message || e) + '). Recarga la página; si sigue, avisa al administrador.</div>';
  });
})();
