/*
 * Modo DEMO de RFIs VC80 (https://rfis-vc80.vercel.app/?demo)
 * - Sin usuario y sin conexión a la base: todo lo que se ve son DATOS FICTICIOS escritos aquí.
 * - Solo lectura: cualquier intento de guardar responde "En la demo no se guarda nada".
 * - Imita los permisos de la base por rol para mostrar qué ve cada uno.
 * La matriz real es información interna (política del Taller 8) y nunca se expone sin sesión.
 */
(function () {
  "use strict";
  const ZONA = "America/Santo_Domingo";
  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: ZONA, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const haceDias = (n) => { const d = new Date(hoy + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  const haceHoras = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  const proyectos = [
    { codigo: "DEMO", nombre: "Obra A (ficticia)", cliente: "Cliente de ejemplo", activo: true, tolerancia_dias: 7, cese_inicio: "2026-12-15", cese_fin: "2027-01-07", creado_en: haceHoras(900) },
    { codigo: "DEMOB", nombre: "Obra B (ficticia)", cliente: "Otro cliente de ejemplo", activo: true, tolerancia_dias: 10, cese_inicio: null, cese_fin: null, creado_en: haceHoras(400) }
  ];
  const tolDe = (cod) => proyectos.find((x) => x.codigo === cod).tolerancia_dias;

  const ROLES = { admin: "demo-admin", residente: "demo-residente", contratista: "demo-contratista", director: "demo-director", consulta: "demo-consulta" };
  const CORREOS = { "demo-admin": "admin@demo.local", "demo-residente": "residente@demo.local", "demo-contratista": "contratista.aa@demo.local", "demo-director": "interventoria@demo.local", "demo-consulta": "consulta@demo.local" };

  const frentes = [
    { codigo: "AA", nombre: "A/A y Cielos" }, { codigo: "ARQ", nombre: "Diseño Arquitectónico" },
    { codigo: "ELEC", nombre: "Redes Eléctricas" }, { codigo: "EST", nombre: "Diseño Estructural" },
    { codigo: "HID", nombre: "Redes Hidrosanitarias" }, { codigo: "MAT", nombre: "Materiales de Acabados" },
    { codigo: "VENT", nombre: "Ventanería, Puertas y Carpintería" }
  ];

  // [id, frente, nivel, necesidad, días desde solicitud (null = solo el mes), ruta crítica, detiene cuadrilla, estado]
  const base = [
    ["RFI-DEMO-001", "AA", "Primer nivel", "Planos de ductos de A/A y altura libre de cielos", 64, true, true, "abierto"],
    ["RFI-DEMO-002", "VENT", "General", "Despiece y alturas de puertas interiores (2.60 o 2.80)", 41, true, true, "abierto"],
    ["RFI-DEMO-003", "MAT", "General", "Selección de porcelanato de pisos y zócalos", 30, true, false, "abierto"],
    ["RFI-DEMO-004", "ELEC", "Segundo nivel", "Ubicación de salidas eléctricas en habitaciones", 6, false, false, "abierto"],
    ["RFI-DEMO-005", "EST", "Techo", "Detalle de anclaje de pérgola en losa", 3, false, false, "abierto"],
    ["RFI-DEMO-006", "HID", "Primer nivel", "Ruta de bajantes pluviales en fachada posterior", null, false, false, "abierto"],
    ["RFI-DEMO-007", "ARQ", "Fachada", "Alzado de antepechos de ventanas", 22, false, false, "abierto"],
    ["RFI-DEMO-008", "MAT", "Cocina", "Tope de cocina: material y espesor", 50, false, false, "cerrado"],
    ["RFI-DEMOB-001", "EST", "Fundación", "Confirmar profundidad de zapatas por estudio de suelo", 12, true, true, "abierto"],
    ["RFI-DEMOB-002", "HID", "Primer nivel", "Ubicación de cisterna y equipo de bombeo", 8, false, false, "abierto"],
    ["RFI-DEMOB-003", "VENT", "Fachada", "Tipo de vidrio para ventanales", 4, false, false, "abierto"]
  ];

  const rfis = base.map(([id, fr, nivel, nec, dias, rc, det, est]) => ({
    id, proyecto_codigo: id.split("-")[1], frente_codigo: fr, nivel, necesidad: nec,
    fecha_solicitud: dias == null ? haceDias(40).slice(0, 8) + "01" : haceDias(dias),
    fecha_solicitud_tipo: dias == null ? "mes" : "dia",
    lead_time_cantidad: null, lead_time_unidad: null, detiene_cuadrilla: det, ruta_critica: rc,
    estado: est, fecha_respuesta: est === "cerrado" ? haceDias(10) : null,
    carta_aprobada_en: id === "RFI-DEMO-001" ? haceHoras(200) : null, responsable_id: null
  }));

  const seg = [];
  let nSeg = 1;
  const nota = (rfi, tipo, texto, horas, por) => seg.push({ id: nSeg++, rfi_id: rfi, tipo, texto, registrado_en: haceHoras(horas), registrado_por: por || "demo-residente" });
  rfis.forEach((r) => {
    const d = base.find((b) => b[0] === r.id)[4] ?? 40;
    nota(r.id, "registro_inicial", "Correo a diseño (ejemplo): se solicita " + r.necesidad.toLowerCase() + ".", d * 24);
  });
  nota("RFI-DEMO-001", "reiteracion", "Reiteración (ejemplo): sin respuesta; la cuadrilla de cielos está detenida.", 40 * 24);
  nota("RFI-DEMO-001", "reiteracion", "Segunda reiteración (ejemplo) con copia a la dirección de obra.", 20 * 24);
  nota("RFI-DEMO-001", "respuesta", "Respuesta técnica (ejemplo): ductos de 14\" por el pasillo; cielo a 2.70 m.", 30, "demo-contratista");
  nota("RFI-DEMO-001", "observacion", "Observación de Interventoría (ejemplo): validar la altura libre con el plano de vigas.", 20, "demo-director");
  nota("RFI-DEMO-002", "reiteracion", "Reiteración (ejemplo): se necesita la altura para pedir los marcos.", 15 * 24);
  nota("RFI-DEMO-003", "reiteracion", "Reiteración (ejemplo): el proveedor necesita 6 semanas de pedido.", 10 * 24);

  const cambios = [
    { id: 1, rfi_id: "RFI-DEMO-002", descripcion: "Subir puertas interiores de 2.60 a 2.80 m (ejemplo)", mayor: true, estado: "pendiente", propuesto_por: "demo-residente", propuesto_en: haceHoras(26), decidido_por: null, decidido_en: null, nota_decision: null },
    { id: 2, rfi_id: "RFI-DEMO-001", descripcion: "Mover rejilla de retorno 40 cm hacia el pasillo (ejemplo)", mayor: false, estado: "pendiente", propuesto_por: "demo-residente", propuesto_en: haceHoras(5), decidido_por: null, decidido_en: null, nota_decision: null },
    { id: 3, rfi_id: "RFI-DEMO-008", descripcion: "Cambiar tope de granito por cuarzo (ejemplo)", mayor: true, estado: "aprobado", propuesto_por: "demo-residente", propuesto_en: haceHoras(300), decidido_por: "demo-director", decidido_en: haceHoras(250), nota_decision: "Aprobado sin costo adicional (ejemplo)" }
  ];

  const auditoria = [
    { id: 5, ocurrido_en: haceHoras(3), usuario_correo: "residente@demo.local", rol: "residente", origen: "app (usuario autenticado)", tabla: "rfis", operacion: "INSERT", llave: "RFI-DEMOB-003", campos_cambiados: null, proyecto_codigo: "DEMOB" },
    { id: 4, ocurrido_en: haceHoras(5), usuario_correo: "residente@demo.local", rol: "residente", origen: "app (usuario autenticado)", tabla: "rfi_cambios", operacion: "INSERT", llave: "2", campos_cambiados: null, proyecto_codigo: "DEMO" },
    { id: 3, ocurrido_en: haceHoras(20), usuario_correo: "interventoria@demo.local", rol: "director", origen: "app (usuario autenticado)", tabla: "rfi_seguimientos", operacion: "INSERT", llave: "11", campos_cambiados: null, proyecto_codigo: "DEMO" },
    { id: 2, ocurrido_en: haceHoras(30), usuario_correo: "contratista.aa@demo.local", rol: "contratista", origen: "app (usuario autenticado)", tabla: "rfi_seguimientos", operacion: "INSERT", llave: "10", campos_cambiados: null, proyecto_codigo: "DEMO" },
    { id: 1, ocurrido_en: haceHoras(200), usuario_correo: "residente@demo.local", rol: "residente", origen: "app (usuario autenticado)", tabla: "rfis", operacion: "UPDATE", llave: "RFI-DEMO-001", campos_cambiados: ["carta_aprobada_en"], proyecto_codigo: "DEMO" }
  ];

  const perfiles = Object.entries(ROLES).map(([rol, id], i) => ({
    id, correo: CORREOS[id], nombre: "Usuario de ejemplo", rol: rol === "admin" ? "admin" : "consulta", activo: true, creado_en: haceHoras(500 - i)
  }));
  // Membresías por proyecto: el contratista y la consulta solo están en la Obra A
  const miembros = [
    ["demo-residente", "DEMO", "residente"], ["demo-residente", "DEMOB", "residente"],
    ["demo-director", "DEMO", "director"], ["demo-director", "DEMOB", "director"],
    ["demo-contratista", "DEMO", "contratista"], ["demo-consulta", "DEMO", "consulta"]
  ].map(([u, p, r]) => ({ usuario_id: u, proyecto_codigo: p, rol: r, frentes: r === "contratista" ? ["AA"] : [], activo: true }));
  const rolEn = (p) => (rolDemo === "admin" ? "admin" : miembros.find((m) => m.usuario_id === uid() && m.proyecto_codigo === p)?.rol);

  const diaNum = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / 864e5); };
  function vista() {
    return rfis.map((r) => {
      const conDia = r.fecha_solicitud_tipo === "dia";
      const dias = conDia ? diaNum(hoy) - diaNum(r.fecha_solicitud) : null;
      const tol = tolDe(r.proyecto_codigo);
      const estado_mora = r.estado === "cerrado" ? "respondido" : !conDia ? "requiere_soporte_oficial" : dias > tol ? "vencido" : dias >= Math.max(tol - 2, 0) ? "por_vencer" : "en_plazo";
      return { ...r, dias_mora: r.estado === "cerrado" ? null : dias, estado_mora, tolerancia_dias: tol,
        reiteraciones: seg.filter((s) => s.rfi_id === r.id && s.tipo === "reiteracion" && visibleSeg(s)).length };
    });
  }

  // Rol con el que se está viendo la demo
  let rolDemo = "residente";
  try { const r = new URLSearchParams(location.search).get("demo"); if (ROLES[r]) rolDemo = r; } catch (e) { /* sin parámetro */ }
  const uid = () => ROLES[rolDemo];
  const proyDe = (rfiId) => rfis.find((r) => r.id === rfiId)?.proyecto_codigo;
  function veRfi(r) {
    const rr = rolEn(r.proyecto_codigo);
    return !!rr && (rr !== "contratista" || ["AA"].includes(r.frente_codigo));
  }
  function visibleSeg(s) {
    const r = rfis.find((x) => x.id === s.rfi_id), rr = r && rolEn(r.proyecto_codigo);
    if (!rr || rr === "consulta") return false;
    if (rr === "contratista") return ["respuesta", "observacion"].includes(s.tipo) && veRfi(r);
    return true;
  }

  // Lo que cada rol puede leer, imitando las políticas de la base
  function tabla(nombre) {
    switch (nombre) {
      case "frentes_tecnicos": return frentes;
      case "proyectos": return proyectos.filter((x) => rolEn(x.codigo));
      case "miembros": return rolDemo === "admin" ? miembros : miembros.filter((m) => m.usuario_id === uid());
      case "v_registro_mora": return vista().filter(veRfi);
      case "rfis": return rfis.filter(veRfi);
      case "rfi_seguimientos": return seg.filter(visibleSeg);
      case "rfi_cambios": return cambios.filter((c) => ["admin", "residente", "director"].includes(rolEn(proyDe(c.rfi_id))));
      case "auditoria_eventos": return auditoria.filter((e) => rolDemo === "admin" || (e.proyecto_codigo && rolEn(e.proyecto_codigo) === "director"));
      case "perfiles": return ["admin", "director"].includes(rolDemo) ? perfiles : perfiles.filter((p) => p.id === uid());
      default: return [];
    }
  }

  const SOLO_LECTURA = { message: "En la demo no se guarda nada. Entra con tu usuario para trabajar con los datos reales." };
  function consulta(nombre) {
    let filas = tabla(nombre).map((f) => ({ ...f })), unico = null, escribe = false, asc = true, campo = null, tope = null;
    const q = {
      select() { return q; }, order(c, o) { campo = c; asc = !o || o.ascending !== false; return q; }, limit(n) { tope = n; return q; },
      eq(k, v) { filas = filas.filter((f) => f[k] === v); return q; }, in(k, vs) { filas = filas.filter((f) => vs.includes(f[k])); return q; },
      like(k, patron) { const re = new RegExp("^" + patron.split("%").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"); filas = filas.filter((f) => re.test(String(f[k] ?? ""))); return q; },
      maybeSingle() { unico = "quizas"; return q; }, single() { unico = "uno"; return q; },
      insert() { escribe = true; return q; }, update() { escribe = true; return q; }, upsert() { escribe = true; return q; }, delete() { escribe = true; return q; },
      then(ok, fallo) {
        if (escribe) return Promise.resolve({ data: null, error: SOLO_LECTURA }).then(ok, fallo);
        if (campo) filas.sort((a, b) => (a[campo] > b[campo] ? 1 : a[campo] < b[campo] ? -1 : 0) * (asc ? 1 : -1));
        if (tope) filas = filas.slice(0, tope);
        if (unico === "uno" && !filas.length) return Promise.resolve({ data: null, error: { message: "No encontrado o sin permiso para tu rol." } }).then(ok, fallo);
        return Promise.resolve({ data: unico ? filas[0] || null : filas, error: null }).then(ok, fallo);
      }
    };
    return q;
  }

  window.crearClienteDemo = function () {
    return {
      demo: true,
      rolDemo: () => rolDemo,
      roles: Object.keys(ROLES),
      auth: {
        getSession: async () => ({ data: { session: { user: { id: uid(), email: CORREOS[uid()] } } } }),
        onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
        signOut: async () => { location.href = location.pathname; return { error: null }; },
        signInWithPassword: async () => ({ error: SOLO_LECTURA }),
        signInWithOtp: async () => ({ error: SOLO_LECTURA }),
        updateUser: async () => ({ error: SOLO_LECTURA })
      },
      from: consulta,
      rpc: async (n) => (n === "accesos_recientes" ? { data: [], error: null } : { data: null, error: SOLO_LECTURA })
    };
  };
})();
