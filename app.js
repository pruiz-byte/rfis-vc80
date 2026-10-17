/*
 * RFIs VC80 · app web (Vercel + Supabase)
 * - Acceso: Supabase Auth con enlace por correo, solo para usuarios invitados.
 * - Permisos: los decide la base por rol (admin, residente, director, consulta). La app solo
 *   oculta botones; aunque alguien los forzara, la base rechaza lo que su rol no permite.
 * - Cálculos: los días los calcula la base (vista v_registro_mora) o este código a partir de
 *   fechas registradas. Ninguna cifra sale de texto escrito por una IA.
 * - Trazabilidad: cada cambio queda en auditoria_eventos con el usuario que lo hizo.
 */
(function () {
  "use strict";
  const cfg = window.APP_CONFIG;
  if (!window.supabase || !cfg) {
    document.getElementById("cargando").innerHTML = '<div class="msg err">No se pudo cargar la conexión con la base. Revisa tu internet y recarga la página; si sigue, avisa al administrador.</div>';
    return;
  }
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const S = { user: null, perfil: null, frentes: [], config: null, filas: [], abierto: null };

  /* ---------- fechas (zona de la obra) ---------- */
  const ZONA = "America/Santo_Domingo";
  function hoyIso() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: ZONA, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }
  const diaNum = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / 864e5); };
  const fmt = (iso) => (iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : "—");
  const fmtHora = (ts) => (ts ? new Intl.DateTimeFormat("es-DO", { timeZone: ZONA, dateStyle: "short", timeStyle: "short" }).format(new Date(ts)) : "—");

  /* ---------- roles ---------- */
  const rol = () => S.perfil?.rol;
  const puede = (...roles) => roles.includes(rol());

  function msg(el, tipo, texto) { $(el).innerHTML = texto ? `<div class="msg ${tipo}">${texto}</div>` : ""; }
  function mostrar(id) {
    ["cargando", "login", "pendiente"].forEach((s) => ($("#" + s).hidden = s !== id));
    $("#app").hidden = id !== "app";
  }

  /* ---------- sesión ---------- */
  async function arrancar() {
    $("#hoy").textContent = fmt(hoyIso());
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
    $("#who-rol").textContent = perfil.rol;
    document.querySelectorAll("nav.tabs button").forEach((b) => {
      const r = b.dataset.roles; b.hidden = r ? !r.split(",").includes(perfil.rol) : false;
    });
    mostrar("app");
    await cargarBase();
    irA("matriz");
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

  /* ---------- navegación ---------- */
  document.querySelectorAll("nav.tabs button").forEach((b) => b.addEventListener("click", () => irA(b.dataset.tab)));
  function irA(t) {
    document.querySelectorAll("nav.tabs button").forEach((x) => x.setAttribute("aria-selected", x.dataset.tab === t));
    document.querySelectorAll("#app section.tab").forEach((s) => (s.hidden = s.id !== t));
    if (t === "matriz") cargarMatriz();
    if (t === "auditoria") cargarAuditoria();
    if (t === "usuarios") cargarUsuarios();
    if (t === "ajustes") pintarAjustes();
  }

  /* ---------- datos base ---------- */
  async function cargarBase() {
    const [fr, cf] = await Promise.all([
      sb.from("frentes_tecnicos").select("codigo,nombre").order("codigo"),
      sb.from("config_proyecto").select("*").eq("id", 1).maybeSingle()
    ]);
    S.frentes = fr.data || [];
    S.config = cf.data || { tolerancia_dias: 7 };
    $("#tol").textContent = S.config.tolerancia_dias;
    const opts = S.frentes.map((f) => `<option value="${esc(f.codigo)}">${esc(f.codigo)} · ${esc(f.nombre)}</option>`).join("");
    $("#f-frente").innerHTML = `<option value="">Todos los frentes</option>` + opts;
    $("#n-frente").innerHTML = `<option value="">Elige el frente</option>` + opts;
  }
  const nombreFrente = (c) => S.frentes.find((f) => f.codigo === c)?.nombre || c;

  /* ---------- matriz ---------- */
  ["#f-estado", "#f-frente", "#f-ruta"].forEach((s) => $(s).addEventListener("change", pintarMatriz));

  async function cargarMatriz() {
    $("#tabla").innerHTML = `<div class="empty"><span class="spin"></span><br>Cargando la matriz…</div>`;
    const { data, error } = await sb.from("v_registro_mora").select("*").order("id");
    if (error) { $("#tabla").innerHTML = ""; msg("#matriz-msg", "err", "No se pudo leer la matriz: " + esc(error.message) + ". Recarga la página; si sigue, avisa al administrador."); return; }
    msg("#matriz-msg", "", "");
    S.filas = data || [];
    pintarMatriz();
  }

  function moraTrasPlazo(f) { return f.dias_mora == null ? null : Math.max(0, f.dias_mora - (S.config?.tolerancia_dias ?? 7)); }
  const PILL = { vencido: ["red", "Vencido"], por_vencer: ["amber", "Por vencer"], en_plazo: ["green", "En plazo"], requiere_soporte_oficial: ["amber", "Requiere soporte oficial"], respondido: ["grey", "Respondido"] };

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
    const [r, b] = await Promise.all([
      sb.from("rfis").select("*").eq("id", id).single(),
      sb.from("rfi_seguimientos").select("tipo,texto,registrado_en,registrado_por").eq("rfi_id", id).order("registrado_en")
    ]);
    if (r.error) { $("#detalle").innerHTML = `<div class="msg err">No se pudo abrir ${esc(id)}: ${esc(r.error.message)}</div>`; return; }
    pintarDetalle(r.data, b.data || []);
    $("#detalle").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function pintarDetalle(x, bit) {
    const fila = S.filas.find((f) => f.id === x.id) || {};
    const editar = puede("admin", "residente");
    const opcFrentes = S.frentes.map((f) => `<option value="${esc(f.codigo)}"${f.codigo === x.frente_codigo ? " selected" : ""}>${esc(f.codigo)} · ${esc(f.nombre)}</option>`).join("");
    const etiquetaTipo = { registro_inicial: "Registro inicial", reiteracion: "Reiteración", respuesta: "Respuesta", cambio: "Cambio de datos" };
    const bitHtml = puede("admin", "residente", "director")
      ? (bit.length ? `<ol class="bitacora">${bit.map((s) => `<li><span class="lbl">${esc(etiquetaTipo[s.tipo] || s.tipo)} · ${esc(fmtHora(s.registrado_en))}</span><div>${esc(s.texto)}</div></li>`).join("")}</ol>` : `<div class="note">Sin entradas.</div>`)
      : `<div class="note">Tu rol no ve la bitácora (contiene correos de terceros).</div>`;

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
      <div class="row"><button class="btn small" type="button" id="d-btn-guardar">Guardar cambios</button>
        ${x.carta_aprobada_en ? "" : `<button class="btn small ghost" type="button" id="d-btn-carta">Registrar carta enviada hoy</button>`}</div>
      <h3>Estado</h3>
      ${x.estado === "abierto"
        ? `<div class="row"><label class="field" for="d-fresp"><span class="lbl">Fecha de respuesta del cliente</span><input id="d-fresp" type="date" value="${hoyIso()}"></label>
           <button class="btn small ghost" type="button" id="d-btn-cerrar">Marcar respondido</button></div>`
        : `<div class="row"><button class="btn small ghost" type="button" id="d-btn-reabrir">Reabrir</button></div>`}
      ` : ""}
      <div id="d-msg"></div>
    </div>`;

    $("#d-cerrar-panel").onclick = () => { $("#detalle").innerHTML = ""; S.abierto = null; };
    if (!editar) return;

    $("#d-btn-reit").onclick = async () => {
      const t = $("#d-reit").value.trim();
      if (!t) return msg("#d-msg", "warn", "Escribe el texto del mensaje antes de agregarlo.");
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
      const { error } = await sb.from("rfis").update({ carta_aprobada_en: new Date().toISOString() }).eq("id", x.id);
      if (error) return msg("#d-msg", "err", "No se registró: " + esc(error.message));
      await refrescar(x.id, "Carta registrada como enviada hoy.");
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
    $("#btn-crear").disabled = true;
    const { data, error } = await sb.rpc("crear_rfi", {
      p_frente: $("#n-frente").value, p_nivel: $("#n-nivel").value, p_necesidad: $("#n-necesidad").value.trim(),
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

  /* ---------- auditoría ---------- */
  const TABLAS = ["rfis", "rfi_seguimientos", "responsables", "frentes_tecnicos", "perfiles", "config_proyecto", "levantamiento_medidas", "areas", "muros", "huecos", "elementos_lineales"];
  $("#a-tabla").innerHTML = `<option value="">Todas las tablas</option>` + TABLAS.map((t) => `<option value="${t}">${t}</option>`).join("");
  $("#a-tabla").addEventListener("change", cargarAuditoria);

  async function cargarAuditoria() {
    $("#audit-tabla").innerHTML = `<span class="spin"></span>`;
    let q = sb.from("auditoria_eventos").select("id,ocurrido_en,usuario_correo,rol,origen,tabla,operacion,llave,campos_cambiados").order("id", { ascending: false }).limit(200);
    if ($("#a-tabla").value) q = q.eq("tabla", $("#a-tabla").value);
    const { data, error } = await q;
    if (error) { $("#audit-tabla").innerHTML = `<div class="msg err">No se pudo leer la auditoría: ${esc(error.message)}</div>`; return; }
    $("#audit-tabla").innerHTML = !data.length ? `<div class="empty"><strong>Sin eventos</strong>Todavía no hay cambios registrados para este filtro.</div>` :
      `<div class="tbl-wrap"><table><thead><tr><th>Fecha</th><th>Quién</th><th>Origen</th><th>Tabla</th><th>Operación</th><th>Registro</th><th>Campos</th></tr></thead><tbody>${
        data.map((e) => `<tr><td class="num">${esc(fmtHora(e.ocurrido_en))}</td><td>${esc(e.usuario_correo || "—")}${e.rol ? `<br><span class="note">${esc(e.rol)}</span>` : ""}</td>
          <td class="wrap note">${esc(e.origen)}</td><td class="mono">${esc(e.tabla)}</td><td>${esc(e.operacion)}</td><td class="mono">${esc(e.llave || "—")}</td>
          <td class="wrap mono">${esc((e.campos_cambiados || []).join(", ") || "—")}</td></tr>`).join("")}</tbody></table></div>`;
    const ac = await sb.rpc("accesos_recientes", { limite: 100 });
    $("#accesos-tabla").innerHTML = ac.error ? `<div class="msg err">No se pudieron leer los accesos: ${esc(ac.error.message)}</div>` :
      !ac.data.length ? `<div class="note">Sin accesos registrados.</div>` :
      `<div class="tbl-wrap"><table><thead><tr><th>Fecha</th><th>Acción</th><th>Usuario</th><th>IP</th></tr></thead><tbody>${
        ac.data.map((a) => `<tr><td class="num">${esc(fmtHora(a.ocurrido_en))}</td><td>${esc(a.accion)}</td><td>${esc(a.usuario || "—")}</td><td class="mono">${esc(a.ip || "—")}</td></tr>`).join("")}</tbody></table></div>`;
  }

  /* ---------- usuarios ---------- */
  async function cargarUsuarios() {
    const { data, error } = await sb.from("perfiles").select("id,correo,nombre,empresa,rol,activo,creado_en").order("creado_en");
    if (error) { $("#usuarios-tabla").innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
    const roles = ["admin", "residente", "director", "consulta"];
    $("#usuarios-tabla").innerHTML = `<div class="tbl-wrap"><table><thead><tr><th>Correo</th><th>Nombre</th><th>Rol</th><th>Activo</th><th></th></tr></thead><tbody>${
      data.map((p) => `<tr data-id="${esc(p.id)}"><td>${esc(p.correo)}</td><td><input class="u-nombre" value="${esc(p.nombre || "")}" aria-label="Nombre"></td>
        <td><select class="u-rol" aria-label="Rol">${roles.map((r) => `<option${r === p.rol ? " selected" : ""}>${r}</option>`).join("")}</select></td>
        <td><input type="checkbox" class="u-activo" aria-label="Activo"${p.activo ? " checked" : ""}></td>
        <td><button class="btn small" type="button">Guardar</button></td></tr>`).join("")}</tbody></table></div>`;
    document.querySelectorAll("#usuarios-tabla tr[data-id] button").forEach((b) => b.addEventListener("click", async () => {
      const tr = b.closest("tr"), id = tr.dataset.id;
      const nuevoRol = tr.querySelector(".u-rol").value, activo = tr.querySelector(".u-activo").checked;
      if (id === S.user.id && (nuevoRol !== "admin" || !activo)) return msg("#usuarios-msg", "warn", "No puedes quitarte tu propio rol de admin desde aquí: te quedarías sin acceso a esta pantalla.");
      const { error } = await sb.from("perfiles").update({ rol: nuevoRol, activo, nombre: tr.querySelector(".u-nombre").value.trim() || null }).eq("id", id);
      msg("#usuarios-msg", error ? "err" : "ok", error ? "No se guardó: " + esc(error.message) : "Usuario actualizado. El cambio quedó en la auditoría.");
    }));
  }

  /* ---------- ajustes ---------- */
  function diasCese(a, b) { return a && b && b >= a ? diaNum(b) - diaNum(a) + 1 : null; }
  function pintarAjustes() {
    const c = S.config || {};
    $("#c-ini").value = c.cese_inicio || ""; $("#c-fin").value = c.cese_fin || "";
    const ed = puede("admin", "residente");
    ["#c-ini", "#c-fin", "#btn-ajustes"].forEach((s) => ($(s).disabled = !ed));
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
    const { error } = await sb.from("config_proyecto").update({ cese_inicio: a, cese_fin: b, actualizado_en: new Date().toISOString() }).eq("id", 1);
    if (error) return msg("#ajustes-msg", "err", "No se guardó: " + esc(error.message));
    S.config.cese_inicio = a; S.config.cese_fin = b;
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
