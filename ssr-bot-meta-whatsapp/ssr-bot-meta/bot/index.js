/**
 * index.js — Orquestador principal de mensajes para Sasha
 * SS Remodelaciones
 *
 * ── CAMBIOS v25 (24 sept 2026) — CANCELAR / CONSULTAR VISITA DESDE INSTAGRAM ──
 * BUG 1: un cliente de Instagram agendó (la visita quedó con su WhatsApp) y al
 *   pedir cancelar, el bot buscó la visita con el id "ig_..." → "no encontré
 *   una visita asociada a este número de WhatsApp".
 * FIX: telefonoAgendaCliente() — en Instagram/Messenger se usa el WhatsApp de
 *   contacto para cancelar y consultar; si no lo tiene, se le pide.
 * BUG 2: "tengo una visita programada para el lunes 28" entraba al flujo de
 *   disponibilidad ("lunes 28 no está disponible", ofrecía fechas) y terminaba
 *   agendando una SEGUNDA visita.
 * FIX: clienteHablaDeVisitaExistente() — esos mensajes saltan el flujo de
 *   disponibilidad y Claude responde con la agenda real (consulta v23).
 *
 * ── CAMBIOS v24 (24 sept 2026) — SASHA EN INSTAGRAM Y MESSENGER ─────────────
 * Sasha atiende también a clientes que escriben por Instagram Direct y
 * Facebook Messenger (ids "ig_..." / "fb_...", misma convención del CRM).
 *   - Envíos vía canales.js (WhatsApp → messenger.js; ig_/fb_ → metaMensajeria.js).
 *   - Estos clientes no pasan por Asistencia (no son trabajadores).
 *   - Si el cliente escribe un número CR, se guarda como whatsapp_contacto y
 *     se usa como teléfono de la visita agendada (confirmaciones/recordatorios
 *     salen por WhatsApp). Claude recibe un [SISTEMA:...] con el canal y la
 *     orden de pedir el WhatsApp antes de agendar si todavía no lo tiene.
 *
 * ── CAMBIOS v23 (24 sept 2026) — SASHA NO CONSULTABA LA AGENDA ───────────────
 * BUG: el cliente preguntó "¿tengo alguna visita agendada con ustedes?" y
 *   Sasha respondió que no tenía acceso a la agenda y que iba a consultar
 *   con el equipo, aunque la visita estaba en Google Calendar.
 * CAUSA RAÍZ: el bot solo leía Calendar para disponibilidad, agendar y
 *   cancelar. Cuando el cliente PREGUNTABA por su visita, el mensaje llegaba
 *   a Claude sin ningún dato de la agenda.
 * FIX: si el cliente habla de su visita/cita (visitasCliente.js →
 *   clienteHablaDeSuVisita), se buscan en Calendar sus visitas futuras por
 *   teléfono (y por nombre como coincidencia posible) y se le inyecta a
 *   Claude un [SISTEMA:...] con el resultado real, con la instrucción de
 *   nunca decir que no tiene acceso a la agenda.
 *
 * ── CAMBIOS v22 (22 sept 2026) — SASHA NO PEDÍA EL NOMBRE DEL CLIENTE ────────
 * BUG REAL (+50662285575): 24 mensajes de conversación, proyecto ya explicado
 *   (cielo raso PVC en toda la casa), y Sasha nunca preguntó el nombre. En el
 *   CRM quedó solo el número, con Proyecto y Zona en "—".
 * CAUSA RAÍZ: nombre/proyecto/zona SOLO se guardaban si Claude emitía
 *   [LEAD:...] o [VISITA:...]. No había ningún control en código: si Claude
 *   no pedía el nombre o no emitía el flag, nada quedaba registrado.
 * FIX (dos capas, esta es la de código — la otra está en claude.js v22):
 *   1) extraerNombreDeclarado(): si el cliente dice "me llamo X", "mi nombre
 *      es X", "Soy X" o llega el formulario de Meta con "Full name: X", el
 *      nombre se guarda en la sesión y en memoria SIN depender de Claude.
 *   2) construirContextoDatosCliente(): desde el 2º mensaje del cliente, si
 *      falta nombre/proyecto/zona, se le inyecta a Claude un [SISTEMA:...]
 *      con los datos guardados y la orden de emitir [LEAD:...] con lo que ya
 *      sepa. Si falta el nombre, le ordena pedirlo (máximo 2 veces, con al
 *      menos 4 mensajes de separación, para no ser insistente).
 *   3) [LEAD:...] ahora acepta campos vacíos y ACTUALIZA el lead cada vez que
 *      aparece un dato nuevo (antes solo se registraba la primera vez).
 *
 * ── HISTORIAL ANTERIOR (resumen) ─────────────────────────────────────────────
 * v21: cancelación de visita por el cliente verificada contra Calendar;
 *      frases "más opciones/otra fecha" disparan consulta real de fechas.
 * v20: agenda interactiva con lista de fechas reales de Calendar; la fecha
 *      elegida por el cliente manda sobre la que proponga Claude.
 * v19: control manual de conversación desde el CRM (pausa por teléfono).
 * v18: confirmación de visitas (botones Sí/No); fusión foto+texto en un solo
 *      registro financiero.
 * v17: guarda de idempotencia — un "Gracias" ya no re-crea una cita confirmada.
 * v15: consultas financieras de solo lectura antes de finanzas.js.
 * v13/v14: disponibilidad genérica verificada; el resultado real de la cita
 *      llega en un mensaje aparte construido desde createVisitEvent().
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { google }                     = require("googleapis");
const { get, update, addMsg, reset } = require("./state");
const { ask }                        = require("./claude");
const {
  sendText,
  sendButtons,
  sendList,
  markRead,
  downloadMedia,
  sendMediaById,
} = require("./canales"); // v24: WhatsApp + Instagram + Messenger

const {
  createVisitEvent,
  getAvailableSlots,
  getAvailableVisitDates,
  verificarDisponibilidadExacta,
  cancelEventByNameAndDate,
  cancelClientVisitByPhone,
  rescheduleEventByNameAndDate,
  listUpcomingEvents,
} = require("./calendar");

const { sendVisitConfirmation }      = require("./email");
const { upsertLead, registerVisit }  = require("./crm");
const KNOWLEDGE                      = require("./knowledge");
const memoria                        = require("./memoria");
const { procesarComandoFinanciero, esComandoFinanciero, procesarComprobanteImagen } = require("./finanzas");
const { esConsultaFinanciera, procesarConsultaFinanciera } = require("./consultas");
const { guardarSolicitante, guardarProveedor, PASOS_SOLICITANTE, PASOS_PROVEEDOR } = require("./rrhh");
const { manejarRespuestaConfirmacion } = require("./confirmaciones");
const { buscarVisitasDelCliente, clienteHablaDeSuVisita, construirContextoVisitas } = require("./visitasCliente");

// ── MÓDULO ASISTENCIA SASHA V1 ───────────────────────────────────────────────
const {
  esTrabajadorSSR,
  procesarAsistencia
} = require("./asistencia");

// ── Constantes ────────────────────────────────────────────────────────────────
const SUPERVISORES = ["+50683091817", "+50671981370", "+50671951695"];

// Número de Darwin — recibe copia de todo movimiento financiero registrado por otros.
const DARWIN_PHONE = "+50683091817";

// ── v8 — Contexto puente texto→imagen para comprobantes ──────────────────────
// Map<supervisorPhoneE164, { texto: string, ts: number }>
const pendingReceiptContext = new Map();
const PENDING_CONTEXT_TTL_MS = 3 * 60 * 1000; // 3 minutos

function guardarContextoPendiente(phoneE164, texto) {
  pendingReceiptContext.set(phoneE164, { texto, ts: Date.now() });
}

// Devuelve el texto pendiente vigente (y lo consume) o "" si no hay / expiró.
function consumirContextoPendiente(phoneE164) {
  const entry = pendingReceiptContext.get(phoneE164);
  if (!entry) return "";
  pendingReceiptContext.delete(phoneE164);
  if (Date.now() - entry.ts > PENDING_CONTEXT_TTL_MS) return "";
  return entry.texto;
}

// ══════════════════════════════════════════════════════════════════════════
// v19 (16 sept 2026) — CONTROL MANUAL DE CONVERSACIÓN (Darwin toma el control)
//
// Desde el CRM, Darwin puede "tomar el control" de la conversación con un
// cliente puntual — mientras dure, Sasha se calla para ESE cliente. Se
// reactiva sola a los 60 minutos de inactividad de Darwin con ese cliente;
// cada mensaje manual (vía /send-message en server.js) reinicia la ventana.
//
// DISEÑO: Map en memoria (telefono → timestamp de expiración). Un redeploy de
// Railway borra las pausas activas (limitación conocida y aceptada).
// ══════════════════════════════════════════════════════════════════════════

const PAUSA_MANUAL_MS = 60 * 60 * 1000; // 60 minutos
const pausasManuales  = new Map();       // "+506...": timestamp ms de expiración

function _normE164(phone) {
  const p = String(phone || "").trim();
  // v24: clientes de Instagram/Messenger se identifican como ig_/fb_ (sin +).
  if (/^\+?(ig|fb)_/i.test(p)) return p.replace(/^\+/, "");
  return p.startsWith("+") ? p : `+${p}`;
}

function pausarConversacion(phone) {
  const fromE164 = _normE164(phone);
  const expira   = Date.now() + PAUSA_MANUAL_MS;
  pausasManuales.set(fromE164, expira);
  console.log(`⏸️ ASISTENCIA MANUAL — pausa activada/renovada para ${fromE164} (expira ${new Date(expira).toLocaleTimeString("es-CR", { timeZone: "America/Costa_Rica" })})`);
  return expira;
}

function reanudarConversacion(phone) {
  const fromE164 = _normE164(phone);
  pausasManuales.delete(fromE164);
  console.log(`▶️ ASISTENCIA MANUAL — pausa liberada para ${fromE164}, Sasha retoma la conversación.`);
}

function estaEnPausaManual(phone) {
  const fromE164 = _normE164(phone);
  const expira   = pausasManuales.get(fromE164);
  if (!expira) return false;
  if (Date.now() >= expira) {
    pausasManuales.delete(fromE164);
    console.log(`▶️ ASISTENCIA MANUAL — pausa de ${fromE164} venció sola (60 min sin actividad de Darwin), Sasha retoma.`);
    return false;
  }
  return true;
}

function msRestantesPausa(phone) {
  const fromE164 = _normE164(phone);
  const expira   = pausasManuales.get(fromE164);
  if (!expira) return 0;
  return Math.max(0, expira - Date.now());
}

// ══════════════════════════════════════════════════════════════════════════
// v18 (15 sept 2026) — FUSIÓN FOTO+TEXTO EN UN SOLO REGISTRO FINANCIERO
//
// Cuando llega una foto de comprobante sin texto que la acompañe, se deja
// en espera unos segundos por si llega el mensaje de texto aclaratorio
// aparte. Si llega, se fusionan en UN solo registro; si no, la foto se
// procesa sola. Evita gastos duplicados (foto y texto como dos registros).
// ══════════════════════════════════════════════════════════════════════════

const pendingPhotosByPhone = new Map();

const PENDING_PHOTO_WAIT_MS = 5000;          // margen para que llegue el texto aclaratorio
const PENDING_PHOTO_TTL_MS  = 3 * 60 * 1000; // igual que el contexto de texto (v8)

function agregarFotoPendiente(phoneE164, imgData) {
  const lista = pendingPhotosByPhone.get(phoneE164) || [];
  const entry = { imgData, ts: Date.now() };
  lista.push(entry);
  pendingPhotosByPhone.set(phoneE164, lista);
  return entry;
}

function quitarFotoPendiente(phoneE164, entry) {
  const lista = pendingPhotosByPhone.get(phoneE164);
  if (!lista) return false;
  const idx = lista.indexOf(entry);
  if (idx === -1) return false;
  lista.splice(idx, 1);
  if (lista.length === 0) pendingPhotosByPhone.delete(phoneE164);
  return true;
}

function tomarFotoPendienteMasAntigua(phoneE164) {
  const lista = pendingPhotosByPhone.get(phoneE164);
  if (!lista || !lista.length) return null;

  const ahora = Date.now();
  while (lista.length && ahora - lista[0].ts > PENDING_PHOTO_TTL_MS) {
    lista.shift();
  }
  if (!lista.length) {
    pendingPhotosByPhone.delete(phoneE164);
    return null;
  }

  const entry = lista.shift();
  if (lista.length === 0) pendingPhotosByPhone.delete(phoneE164);
  return entry;
}

// ¿El texto es un comando financiero pero SIN monto detectable?
function esComandoFinancieroSinMonto(texto) {
  if (!esComandoFinanciero(texto)) return false;
  return !/\d/.test(texto); // ningún dígito en el mensaje → no hay monto
}

// ── FIX v3 — Desenvolver instrucciones de voz antes del parser financiero ────
function desenvolverInstruccionVoz(texto) {
  if (!texto) return texto;
  const m = texto.match(/^\[Instrucci[oó]n de voz de supervisor\s*\([^)]*\):\s*"([\s\S]*)"\]$/i);
  return m ? m[1].trim() : texto;
}

// ── v5 — Sanitizar respuestas financieras antes de enviarlas ─────────────────
function sanitizarRespuestaFinanciera(respuesta) {
  if (!respuesta) return respuesta;

  const contieneHTML = /<!DOCTYPE|<html|<head|<body|<meta\s/i.test(respuesta);

  if (!contieneHTML) {
    return respuesta.length > 1500 ? respuesta.slice(0, 1500) + "…" : respuesta;
  }

  console.error("⚠️ Webhook Apps Script devolvió HTML (URL rota o sin acceso):", respuesta.slice(0, 500));

  return [
    "❌ *Error de conexión con el ERP*",
    "",
    "El movimiento se interpretó bien, pero no se pudo guardar en la planilla.",
    "Causa probable: la URL del webhook de Apps Script cambió o la implementación no está publicada.",
    "",
    "🔧 *Cómo arreglarlo:*",
    "1. Apps Script → Implementar → Administrar implementaciones",
    "2. Copiar la URL /exec de la implementación activa",
    "3. Actualizar la variable en Railway y redeploy",
    "",
    "⚠️ Registrá este movimiento manualmente en la planilla mientras tanto.",
  ].join("\n");
}

// Envía una copia de la confirmación financiera a Darwin cuando OTRO supervisor
// (ej: Melvin) registra un gasto/ingreso. Si lo registró Darwin, no se duplica.
async function copiaFinancieraADarwin(quienRegistro, respuesta) {
  if (quienRegistro === DARWIN_PHONE) return;            // no copiar lo propio
  if (!respuesta || !respuesta.startsWith("✅")) return;  // solo registros exitosos
  const quien = nombreSupervisor(quienRegistro);
  const copia = `📋 *Copia — movimiento registrado por ${quien}*\n\n${respuesta}`;
  sendText(DARWIN_PHONE, copia).catch(err =>
    console.warn("⚠️ No se pudo enviar copia financiera a Darwin:", err.message)
  );
}

// Planilla madre del sistema operativo SSR
const PLANILLA_SHEET_ID = "1txCpYo8h30i_GW-aa0M59AwsukgRr3rjlKbgRguz9eA";

const CAJA_TAB  = "CAJA_GENERAL";
const AUDIT_TAB = "AUDIT_LOG";

const TZ = "America/Costa_Rica";

const IGNORAR         = [];
const IGNORAR_PREFIJOS = ["+57"];

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER — Google Sheets auth para planilla
// ═══════════════════════════════════════════════════════════════════════════════
async function getPlanillaSheets() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("Variable GOOGLE_SERVICE_ACCOUNT no configurada en Railway");
  const creds = JSON.parse(raw);
  const auth  = new google.auth.JWT({
    email:  creds.client_email,
    key:    creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

function nombreSupervisor(phone) {
  const map = {
    "+50683091817": "Darwin",
    "+50671981370": "Melvin",
  };
  return map[phone] || phone;
}

// Formatea un número a colones con punto como separador de miles (₡10.000).
function fmtColones(n) {
  if (n === null || n === undefined || isNaN(n)) return String(n ?? "");
  return Math.round(n).toLocaleString("de-DE");
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS — registro financiero vía finanzas.js → Apps Script
// ═══════════════════════════════════════════════════════════════════════════════
function extraerComandoEstructurado(cmd, tipo) {
  const re = new RegExp("^\\[" + tipo + ":\\s*", "i");
  return String(cmd || "").replace(re, "").replace(/\]\s*$/, "").trim();
}

async function registrarFinanzasConCopia(tipo, cmd, supervisorPhone) {
  try {
    const contenido = extraerComandoEstructurado(cmd, tipo);
    if (!contenido) {
      return tipo === "GASTO"
        ? "⚠️ Formato correcto:\n`[GASTO: 50000 | descripción | proyecto opcional]`"
        : "⚠️ Formato correcto:\n`[INGRESO: 50000 | descripción | proyecto opcional]`";
    }

    const comando = `[${tipo}: ${contenido}]`;
    const respuesta = await procesarComandoFinanciero(comando);

    if (!respuesta) {
      return `⚠️ No pude interpretar el ${tipo.toLowerCase()}. Probá con:\n${comando}`;
    }

    // v5: nunca dejar pasar HTML del webhook hacia WhatsApp
    return sanitizarRespuestaFinanciera(respuesta);
  } catch (err) {
    console.error(`❌ registrarFinanzasConCopia ${tipo}:`, err.message, err.stack);
    return sanitizarRespuestaFinanciera(`❌ No se pudo registrar el ${tipo.toLowerCase()}: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLER — [GASTO: monto | descripcion]
// ═══════════════════════════════════════════════════════════════════════════════
async function handleGasto(cmd, supervisorPhone) {
  return await registrarFinanzasConCopia("GASTO", cmd, supervisorPhone);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLER — [INGRESO: monto | descripcion | proyecto?]
// ═══════════════════════════════════════════════════════════════════════════════
async function handleIngreso(cmd, supervisorPhone) {
  return await registrarFinanzasConCopia("INGRESO", cmd, supervisorPhone);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLER — [MSG_CLIENTE: nombre_o_tel | mensaje]
// ═══════════════════════════════════════════════════════════════════════════════
async function handleMsgCliente(cmd, supervisorPhone) {
  const contenido = cmd.replace(/^\[MSG_CLIENTE:\s*/i, "").replace(/\]$/, "").trim();
  const pipeIdx   = contenido.indexOf("|");

  if (pipeIdx === -1) {
    return [
      `⚠️ Formato correcto:`,
      `\`[MSG_CLIENTE: nombre_o_número | mensaje]\``,
      ``,
      `Ejemplos:`,
      `• \`[MSG_CLIENTE: Teresita | Le confirmamos que su presupuesto ya está listo]\``,
      `• \`[MSG_CLIENTE: +50688086892 | Su visita queda para el viernes a las 10am]\``,
    ].join("\n");
  }

  const destinatario = contenido.slice(0, pipeIdx).trim();
  const mensaje      = contenido.slice(pipeIdx + 1).trim();

  if (!mensaje) return "⚠️ El mensaje está vacío. Indicá qué querés enviarle al cliente.";

  // ── Resolver teléfono del destinatario ───────────────────────────────────
  let phoneDestino  = null;
  let nombreCliente = destinatario;
  const soloDigitos = destinatario.replace(/\D/g, "");

  if (soloDigitos.length >= 8) {
    phoneDestino  = soloDigitos.startsWith("506") ? `+${soloDigitos}` : `+506${soloDigitos}`;
    nombreCliente = destinatario;
  } else {
    const rowsMem = await memoria.buscarPorNombre(destinatario, 5).catch(() => []);
    if (rowsMem.length > 0) {
      const tel = (rowsMem[0][1] || "").replace(/\D/g, "");
      phoneDestino  = tel.startsWith("506") ? `+${tel}` : `+506${tel}`;
      nombreCliente = rowsMem[0][2] || destinatario;
    } else {
      const crmRows = await memoria.buscarClienteEnCRM(destinatario).catch(() => []);
      if (crmRows.length > 0) {
        const tel = (crmRows[0][1] || "").replace(/\D/g, "");
        phoneDestino  = tel.startsWith("506") ? `+${tel}` : `+506${tel}`;
        nombreCliente = crmRows[0][2] || destinatario;
      }
    }
  }

  if (!phoneDestino) {
    return [
      `📭 No encontré el número de *"${destinatario}"* en el sistema.`,
      ``,
      `Usá el número directamente:`,
      `\`[MSG_CLIENTE: +506XXXXXXXX | ${mensaje}]\``,
    ].join("\n");
  }

  // ── Enviar mensaje ───────────────────────────────────────────────────────
  try {
    await sendText(phoneDestino, mensaje);

    memoria.guardarMensaje({
      phone:      phoneDestino,
      clientName: nombreCliente,
      direction:  "out",
      type:       "text",
      content:    mensaje,
      session:    null,
    }).catch(() => {});

    console.log(`✅ MSG_CLIENTE enviado a ${phoneDestino} (${nombreCliente})`);
    return [
      `✅ *Mensaje enviado a ${nombreCliente}*`,
      `📱 ${phoneDestino}`,
      ``,
      `💬 _"${mensaje}"_`,
      ``,
      `👤 Enviado por: ${nombreSupervisor(supervisorPhone)}`,
    ].join("\n");

  } catch (err) {
    console.error("❌ handleMsgCliente:", err.message);
    return `❌ No se pudo enviar el mensaje a ${phoneDestino}: ${err.message}`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER v10/v11 — Calcular el día de la semana REAL de una fecha específica
// usando JavaScript, en vez de dejar que Claude lo calcule de memoria.
// ═══════════════════════════════════════════════════════════════════════════════
const DIAS_SEMANA_ES = ["domingo","lunes","martes","miercoles","jueves","viernes","sabado"];
const MESES_ES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto",
                   "septiembre","octubre","noviembre","diciembre"];
const DIAS_HABILES = ["lunes","martes","viernes"];
const NOMBRES_DIA_NO_HABIL = ["miercoles","jueves","sabado","domingo"];

// v13/v21 — frases de disponibilidad genérica (sin día ni fecha puntual).
// Fuerzan una consulta real a Calendar en vez de dejar que Claude invente.
const PALABRAS_DISPONIBILIDAD_GENERICA = [
  "cuando se puede", "cuando pueden", "cuando podrian", "cuando podrían",
  "que dia", "que día", "que dias", "qué días", "cuales dias", "cuáles días",
  "disponibilidad", "tienen espacio", "hay espacio", "cuando llegan",
  "cuando vienen", "pueden llegar", "pueden venir", "cuando hay",
  "que horarios", "qué horarios", "cuando tienen", "cuándo tienen",
  "cuando es la visita", "cuando seria", "cuando sería",
  "mas opciones", "más opciones", "otras opciones", "otras fechas",
  "otra fecha", "otro dia", "otro día", "mas dias", "más días",
  "mas fechas", "más fechas", "algo mas", "algo más", "otro horario",
  "otros horarios", "mas alternativas", "más alternativas",
];

function calcularFechaYDiaSemana(dayMentioned) {
  if (!dayMentioned) return null;
  if (/^(lunes|martes|viernes)$/i.test(dayMentioned)) return null; // nombre de día, no hace falta
  if (NOMBRES_DIA_NO_HABIL.includes(dayMentioned)) return null;    // nombre de día no hábil, se maneja aparte

  const now = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  let candidate = null;

  const mFecha = dayMentioned.match(/^(\d{1,2})\s+de\s+([a-záéíóúñ]+)$/i);
  if (mFecha) {
    const dia    = parseInt(mFecha[1]);
    const mesIdx = MESES_ES.indexOf(mFecha[2].toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
    if (mesIdx >= 0) {
      candidate = new Date(now.getFullYear(), mesIdx, dia);
      if (candidate < now) candidate = new Date(now.getFullYear() + 1, mesIdx, dia);
    }
  } else {
    const mSlash = dayMentioned.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (mSlash) {
      candidate = new Date(now.getFullYear(), parseInt(mSlash[2]) - 1, parseInt(mSlash[1]));
      if (candidate < now) candidate = new Date(now.getFullYear() + 1, parseInt(mSlash[2]) - 1, parseInt(mSlash[1]));
    }
  }

  if (!candidate || isNaN(candidate.getTime())) return null;
  return { date: candidate, diaSemana: DIAS_SEMANA_ES[candidate.getDay()] };
}

// v11 — Formatea una lista de fechas (Date[]) ya calculadas.
function formatearListaFechas(fechas) {
  return fechas.map(d => {
    const nombreDia    = d.toLocaleDateString("es-CR", { timeZone: TZ, weekday: "long" });
    const fechaLegible = d.toLocaleDateString("es-CR", { timeZone: TZ, day: "numeric", month: "long" });
    return `${nombreDia} ${fechaLegible}`;
  }).join(", ");
}

// ═══════════════════════════════════════════════════════════════════════════════
// v20 — AGENDA INTERACTIVA CON DISPONIBILIDAD REAL DE GOOGLE CALENDAR
// Google Calendar es la única fuente de verdad. Los IDs agenda_fecha_* son
// determinísticos y server.js los entrega a handleMessage() como texto.
// ═══════════════════════════════════════════════════════════════════════════════

function fechaISOaLegibleAgenda(fechaISO) {
  if (!fechaISO || !/^\d{4}-\d{2}-\d{2}$/.test(fechaISO)) {
    return fechaISO || "";
  }

  const [year, month, day] = fechaISO.split("-").map(Number);

  // Mediodía evita desplazamientos de fecha por diferencias de zona horaria.
  const fecha = new Date(year, month - 1, day, 12, 0, 0);

  return fecha.toLocaleDateString("es-CR", {
    timeZone: TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}


function capitalizarAgenda(texto) {
  const t = String(texto || "").trim();
  if (!t) return "";
  return t.charAt(0).toUpperCase() + t.slice(1);
}


// Consulta SIEMPRE Google Calendar. No reutiliza listas viejas de la sesión.
async function obtenerFechasRealesAgenda({
  daysAhead = 35,
  maxDates = 10,
} = {}) {
  const resultado = await getAvailableVisitDates({
    daysAhead,
    maxDates,
  });

  if (!resultado || resultado.ok !== true) {
    throw new Error("No se pudo obtener disponibilidad real del calendario.");
  }

  return Array.isArray(resultado.availableDates)
    ? resultado.availableDates
    : [];
}


// Muestra al cliente hasta 10 fechas REALES mediante una lista interactiva.
// Cada fila devuelve un ID tipo agenda_fecha_2026-09-21.
async function enviarListaFechasAgenda(from, {
  daysAhead = 35,
  maxDates = 10,
  texto = "Estas son las próximas fechas disponibles para una visita técnica:",
} = {}) {
  const fechas = await obtenerFechasRealesAgenda({
    daysAhead,
    maxDates,
  });

  if (fechas.length === 0) {
    await sendText(
      from,
      "📭 En este momento no encuentro fechas disponibles para visita técnica en las próximas semanas.\n\nVoy a necesitar que nuestro equipo revise la agenda."
    );

    return {
      ok: false,
      reason: "sin_fechas",
      fechas: [],
    };
  }

  const rows = fechas.slice(0, 10).map(item => {
    const fechaISO = item.date;
    const legible =
      item.label ||
      fechaISOaLegibleAgenda(fechaISO);

    return {
      id: `agenda_fecha_${fechaISO}`,
      title: capitalizarAgenda(legible).slice(0, 24),
      description: "Visita técnica · 9:00 a.m.",
    };
  });

  await sendList(
    from,
    `${texto}\n\n📅 Seleccione el día que le funciona mejor.\n🕘 Las visitas se realizan a las 9:00 a.m.`,
    "Ver fechas",
    [
      {
        title: "Fechas disponibles",
        rows,
      },
    ]
  );

  return {
    ok: true,
    fechas,
  };
}


// Reconoce exclusivamente IDs generados por nuestra propia lista.
function extraerFechaAgendaInteractiva(texto) {
  const match = String(texto || "")
    .trim()
    .match(/^agenda_fecha_(\d{4}-\d{2}-\d{2})$/);

  return match ? match[1] : null;
}


// Verifica que una fecha seleccionada siga disponible AHORA MISMO.
// createVisitEvent() vuelve a validar justo antes de insertar el evento.
async function fechaSigueDisponibleAgenda(fechaISO) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fechaISO || ""))) {
    return false;
  }

  try {
    // La visita de clientes siempre es a las 09:00 hora Costa Rica.
    // Offset explícito para no depender de la zona horaria de Railway.
    const startDate = new Date(`${fechaISO}T09:00:00-06:00`);

    const resultado =
      await verificarDisponibilidadExacta(startDate);

    return resultado?.disponible === true;

  } catch (err) {
    console.error(
      `❌ Error revalidando fecha exacta ${fechaISO}:`,
      err.message
    );

    // Ante un error de Calendar nunca asumimos disponibilidad.
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER v9 — Formatear rechazo de disponibilidad y sugerir alternativas reales
// ═══════════════════════════════════════════════════════════════════════════════

async function formatearRechazoDisponibilidad(eventData, day) {
  const reason =
    eventData?.reason ||
    eventData?.motivo ||
    "no_disponible";

  const conflict =
    eventData?.conflict ||
    eventData?.conflicto ||
    null;

  const motivoTexto = {
    dia_bloqueado:
      "el día está bloqueado internamente",

    slot_ocupado:
      "ese horario ya está ocupado",

    dia_no_laborable:
      "esa fecha no cae en un día de visitas (solo trabajamos lunes, martes y viernes)",

    error_calendario:
      "no se pudo consultar el calendario en este momento",
  }[reason] || "no está disponible";

  const lineas = [
    `⚠️ No se pudo agendar: ${motivoTexto}${conflict ? ` (${conflict})` : ""}.`,
  ];

  // Si Calendar falló, no afirmamos disponibilidad.
  if (reason === "error_calendario") {
    lineas.push(
      "ℹ️ No pude verificar fechas alternativas en este momento. Reintentá en unos minutos o revisá la agenda manualmente en Calendar."
    );

    return lineas.join("\n");
  }

  // Si el día solicitado todavía puede tener disponibilidad, consultamos Calendar.
  if (
    day &&
    reason !== "dia_no_laborable" &&
    reason !== "dia_bloqueado"
  ) {
    try {
      const resultado = await getAvailableSlots(day);

      const slots = Array.isArray(resultado?.slots)
        ? resultado.slots
        : [];

      if (slots.length > 0) {
        const slotsText = slots.map(slot => {
          const [h, m] = slot.split(":");
          const hNum = parseInt(h, 10);

          const h12 =
            hNum > 12
              ? hNum - 12
              : hNum === 0
                ? 12
                : hNum;

          return `${h12}:${m} ${hNum >= 12 ? "p.m." : "a.m."}`;
        }).join(", ");

        lineas.push(
          `🕐 Horarios realmente libres ${
            resultado?.dateLabel
              ? `el ${resultado.dateLabel}`
              : "ese día"
          }: ${slotsText}`
        );

        return lineas.join("\n");
      }

    } catch (err) {
      console.warn(
        `⚠️ No se pudieron consultar slots alternativos para "${day}":`,
        err.message
      );
    }
  }

  // Si ese día no sirve, buscamos próximas fechas realmente libres.
  try {
    const disponibilidad = await getAvailableVisitDates({
      daysAhead: 35,
      maxDates: 5,
    });

    const fechas = Array.isArray(disponibilidad?.availableDates)
      ? disponibilidad.availableDates
      : [];

    if (disponibilidad?.ok === true && fechas.length > 0) {
      const fechasTexto = fechas.map(item => {
        const fechaISO = item.date;

        const legible =
          item.label ||
          fechaISOaLegibleAgenda(fechaISO);

        return `${capitalizarAgenda(legible)} a las 9:00 a.m.`;
      });

      lineas.push(
        `📅 Próximas fechas realmente disponibles:\n${fechasTexto
          .map(fecha => `• ${fecha}`)
          .join("\n")}`
      );

    } else {
      lineas.push(
        "📭 No encontré fechas disponibles para visita técnica en las próximas semanas."
      );
    }

  } catch (err) {
    console.error(
      "❌ Error buscando fechas alternativas reales:",
      err.message
    );

    lineas.push(
      "ℹ️ No pude consultar fechas alternativas en este momento. Reintentá en unos minutos o revisá la agenda manualmente en Calendar."
    );
  }

  return lineas.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLER — [VISITA: tel_cliente | nombre | proyecto | zona | dia | hora | ubicacion | email]
// ═══════════════════════════════════════════════════════════════════════════════
async function handleVisitaSupervisor(cmd, supervisorPhone) {
  const contenido = cmd.replace(/^\[VISITA:\s*/i, "").replace(/\]$/, "").trim();
  const partes    = contenido.split("|").map(p => p.trim());

  if (partes.length < 4) {
    return [
      `⚠️ Formato para agendar visita de un cliente:`,
      `\`[VISITA: tel_cliente | nombre | proyecto | zona | dia | hora | ubicacion | email]\``,
      ``,
      `Ejemplo:`,
      `\`[VISITA: +50688086892 | Teresita Varela | Cielo raso gypsum | Coronado | viernes | 10:00 | https://waze.link | correo@mail.com]\``,
      ``,
      `El teléfono del cliente es opcional. Sin teléfono:`,
      `\`[VISITA: nombre | proyecto | zona | dia | hora]\``,
    ].join("\n");
  }

  const primerCampo  = partes[0].replace(/\D/g, "");
  const esTelefono   = primerCampo.length >= 8;

  let telefonoCliente, name, project, zone, day, hour, ubicacion, email;

  if (esTelefono) {
    const telClean   = primerCampo.startsWith("506") ? primerCampo : `506${primerCampo}`;
    telefonoCliente  = `+${telClean}`;
    [, name, project, zone, day, hour, ubicacion, email] = partes;
  } else {
    telefonoCliente = supervisorPhone;
    [name, project, zone, day, hour, ubicacion, email] = partes;
  }

  name      = name      || "Cliente";
  project   = project   || "";
  zone      = zone      || "";
  day       = day       || "a coordinar";
  hour      = hour      || "09:00";
  ubicacion = ubicacion || "";
  email     = email     || "";

  try {

    const eventData = await createVisitEvent({
      name,
      phone: telefonoCliente,
      email,
      project,
      zone,
      day,
      hour,
      notes: ubicacion
        ? `Ubicación / Waze: ${ubicacion}`
        : "",
    });

    // Nunca confirmamos al supervisor ni al cliente si Calendar no creó el evento.
    if (eventData.success !== true) {
      console.warn(
        `⛔ handleVisitaSupervisor: no se creó el evento (${eventData.reason || "error_desconocido"})`
      );

      const rechazo = await formatearRechazoDisponibilidad(
        eventData,
        day
      );

      return [
        `❌ *No se agendó la visita de ${name}*`,
        ``,
        rechazo,
        ``,
        `Reintentá con \`[VISITA: ...]\` usando otro día/hora, o coordinalo manualmente en Calendar.`,
      ].join("\n");
    }

    const dateStr = eventData.date.toLocaleDateString("es-CR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: TZ,
    });

    const [hh, mm] = hour.split(":");
    const hourNum  = parseInt(hh);
    const h12      = hourNum > 12 ? hourNum - 12 : hourNum || 12;
    const timeStr  = `${h12}:${mm} ${hourNum >= 12 ? "p.m." : "a.m."}`;

    if (esTelefono) {
      const msgCliente = [
        `¡Hola ${name}! 😊 Le escribimos de *SS Remodelaciones*.`,
        ``,
        `Su visita técnica quedó agendada para el *${dateStr} a las ${timeStr}*.`,
        ubicacion && `📍 Estaremos en: ${ubicacion}`,
        ``,
        `¿Tiene alguna consulta? Con gusto le atendemos. ¡Hasta pronto! 🏗️`,
      ].filter(Boolean).join("\n");

      sendText(telefonoCliente, msgCliente).catch(err =>
        console.warn(`⚠️ No se pudo notificar al cliente ${telefonoCliente}:`, err.message)
      );
    }

    console.log(`✅ VISITA supervisor agendada: ${name} — ${dateStr} ${timeStr}`);
    return [
      `✅ *Visita agendada*`,
      ``,
      `👤 Cliente: *${name}*`,
      esTelefono && `📱 Tel: ${telefonoCliente}`,
      `🏗️ Proyecto: ${project || "—"}`,
      `📍 Zona: ${zone || "—"}`,
      `📅 Fecha: *${dateStr}*`,
      `🕐 Hora: *${timeStr}*`,
      ubicacion && `🗺️ Ubicación: ${ubicacion}`,
      eventData.rescheduled ? `🔄 Se reemplazó una cita anterior de este cliente.` : "",
      ``,
      esTelefono
        ? `✉️ Cliente notificado automáticamente por WhatsApp.`
        : `ℹ️ Para notificar al cliente, usá [MSG_CLIENTE: número | mensaje].`,
    ].filter(Boolean).join("\n");

  } catch (err) {
    console.error("❌ handleVisitaSupervisor:", err.message);
    return `❌ No se pudo agendar la visita: ${err.message}`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// v7 — GESTIÓN DE CALENDARIO PARA SUPERVISORES
// Cancelar, reagendar y consultar citas por lenguaje natural (texto o audio).
// ═══════════════════════════════════════════════════════════════════════════════

function mencionaCalendario(texto) {
  const n = (texto || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const hablaDeCitas   = /\b(cita|citas|visita|visitas|evento|eventos|reunion|reuniones|agenda|calendario)\b/.test(n);
  const tieneAccion    = /\b(cancel|borr|elimin|quit|cambi|mov[ea]|move|pas[aá]|reagend|reprogram|corr[ea]|adelant|atras|que|cual|cuales|hay|tengo|tenemos|mostr|dame|decime|dime|lista|ver)\w*\b/.test(n);
  return hablaDeCitas && tieneAccion;
}

// Interpretar el comando con Claude → JSON estructurado.
async function interpretarComandoCalendario(texto) {
  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const hoy = new Date().toLocaleDateString("es-CR", {
      timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric",
    });

    const system = `Sos el intérprete de comandos de calendario del bot de SS Remodelaciones (Costa Rica). Hoy es ${hoy}.
Un supervisor te da una instrucción sobre citas/visitas técnicas. Respondé SOLO un JSON puro válido, sin markdown ni backticks:
{"accion":"cancelar"|"reagendar"|"consultar"|"ninguna","nombre":"nombre del cliente o null","fecha":"fecha ACTUAL de la cita mencionada o null","nuevaFecha":"NUEVA fecha destino (solo reagendar) o null","nuevaHora":"NUEVA hora destino tipo 10:00 o 2pm (solo reagendar) o null","avisarCliente":true|false}

REGLAS:
- "cancelar": borrar/eliminar/quitar una cita.
- "reagendar": cambiar/mover/pasar/correr una cita a otra fecha u hora.
- "consultar": preguntar qué citas hay ("qué citas hay mañana", "agenda del viernes").
- "ninguna": el mensaje NO es una instrucción de calendario (ej: registrar un gasto, pregunta general).
- fecha/nuevaFecha: usar exactamente palabras como "hoy", "mañana", "viernes", "15 de julio", "15/07". NO inventar fechas.
- "mañana" NUNCA es un nombre de persona.
- avisarCliente: false SOLO si dice explícitamente "sin avisar", "no le avises", "sin notificar". Si no lo dice, true.
- Nombres: extraer solo el nombre propio del cliente (ej: de "la cita de Gabriela Mora" → "Gabriela Mora").`;

    const r = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system,
      messages: [{ role: "user", content: texto }],
    });

    const txt = (r.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    const a = txt.indexOf("{");
    const b = txt.lastIndexOf("}");
    if (a < 0 || b < 0) return null;

    const parsed = JSON.parse(txt.slice(a, b + 1));
    console.log("📅 Interpretación calendario:", JSON.stringify(parsed));
    return parsed;

  } catch (err) {
    console.warn("⚠️ interpretarComandoCalendario falló, usando fallback regex:", err.message);
    return interpretarCalendarioFallback(texto);
  }
}

// Fallback sin API: regex simple.
function interpretarCalendarioFallback(texto) {
  const n = (texto || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const esCancelacion = /\b(cancel|borr[ae]|elimin|quit)\w*\b/.test(n);
  const esReagenda    = /\b(cambi|mov[ea]|pas[aá]|reagend|reprogram|corr[ea])\w*\b/.test(n);
  if (!esCancelacion && !esReagenda) return null;

  let fecha = null;
  const fechaPatterns = [
    /\b(manana)\b/, /\b(hoy)\b/,
    /\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/,
    /(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/,
    /\b(\d{1,2})\/(\d{1,2})\b/,
  ];
  for (const re of fechaPatterns) {
    const m = n.match(re);
    if (m) { fecha = m[0].trim(); break; }
  }

  let nombre = null;
  const conMatch = texto.match(/\b(?:con|de|a)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/);
  if (conMatch) nombre = conMatch[1].trim();

  const EXCLUDE = ["manana","mañana","hoy","la","el","los","las","una","un","cita","visita","evento",
                   "lunes","martes","miercoles","jueves","viernes","sabado","domingo"];
  const nombreNorm = (nombre || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (nombre && EXCLUDE.includes(nombreNorm)) nombre = null;

  return {
    accion: esReagenda ? "reagendar" : "cancelar",
    nombre, fecha, nuevaFecha: null, nuevaHora: null, avisarCliente: true,
  };
}

// Busca el teléfono de un cliente por nombre en memoria y luego en el CRM.
// Devuelve "+506..." o null si no hay un teléfono confiable.
async function buscarTelefonoClientePorNombre(nombre) {
  const rowsMem = await memoria.buscarPorNombre(nombre, 5).catch(() => []);
  if (rowsMem.length > 0) {
    const tel = String(rowsMem[0][1] || "").replace(/\D/g, "");
    if (tel.length >= 8) return tel.startsWith("506") ? `+${tel}` : `+506${tel}`;
  }

  const crmRows = await memoria.buscarClienteEnCRM(nombre).catch(() => []);
  if (crmRows.length > 0) {
    const tel = String(crmRows[0][1] || "").replace(/\D/g, "");
    if (tel.length >= 8) return tel.startsWith("506") ? `+${tel}` : `+506${tel}`;
  }

  return null;
}

// Ejecutor principal: interpreta y ejecuta. Devuelve texto para el supervisor
// o null si el mensaje no era de calendario (para que siga al próximo paso).
async function gestionarCalendarioSupervisor(texto, supervisorPhone) {
  if (!mencionaCalendario(texto)) return null;

  const intent = await interpretarComandoCalendario(texto);
  if (!intent || intent.accion === "ninguna") return null;

  const quien = nombreSupervisor(supervisorPhone);

  // ── CONSULTAR agenda ────────────────────────────────────────────────────────
  if (intent.accion === "consultar") {
    try {
      const eventos = await listUpcomingEvents({ dateHint: intent.fecha });
      if (eventos.length === 0) {
        return intent.fecha
          ? `📭 No hay citas agendadas para *${intent.fecha}*.`
          : `📭 No hay citas agendadas en los próximos 14 días.`;
      }
      const lineas = eventos.map(e => `• ${e.summary}\n  📅 ${e.dateStr}`).join("\n\n");
      const titulo = intent.fecha ? `📅 *Citas para ${intent.fecha}:*` : `📅 *Próximas citas (14 días):*`;
      return `${titulo}\n\n${lineas}`;
    } catch (err) {
      console.error("❌ Error consultando agenda:", err.message);
      return `❌ Error consultando la agenda: ${err.message}`;
    }
  }

  // ── CANCELAR ────────────────────────────────────────────────────────────────
  if (intent.accion === "cancelar") {
    if (!intent.nombre && !intent.fecha) {
      return `⚠️ ¿Cuál cita cancelo? Decime el nombre del cliente o la fecha.\n\nEjemplos:\n• *cancela la cita de mañana con Gabriela*\n• *borra la visita del viernes*`;
    }
    try {
      const result = await cancelEventByNameAndDate({ nameHint: intent.nombre, dateHint: intent.fecha });
      if (result.deleted === 0) {
        const q = intent.nombre ? ` de *${intent.nombre}*` : "";
        const c = intent.fecha  ? ` para *${intent.fecha}*` : "";
        return `📭 No encontré ninguna cita${q}${c}.\n\nVerificá el nombre o la fecha e intentá de nuevo.`;
      }

      // Cancelación confirmada por Google Calendar.
      // calendar.js devuelve result.deleted y result.events = [{ id, summary, date }]
      let clienteNotificado = false;

      if (intent.avisarCliente !== false && intent.nombre) {
        try {
          const telefonoCliente = await buscarTelefonoClientePorNombre(intent.nombre);

          if (telefonoCliente && !SUPERVISORES.includes(telefonoCliente)) {
            const fechasCanceladas = result.events
              .map(ev => ev.date)
              .filter(Boolean)
              .join(", ");

            const msgCliente = [
              `Hola, le escribimos de *SS Remodelaciones* 🏗️`,
              ``,
              `Le informamos que su visita técnica${fechasCanceladas ? ` del *${fechasCanceladas}*` : ""} fue cancelada.`,
              ``,
              `Si desea reprogramarla, con gusto le atendemos por este medio.`,
              `¡Disculpe las molestias! 🙏`,
            ].join("\n");

            await sendText(telefonoCliente, msgCliente);
            clienteNotificado = true;
          }

        } catch (err) {
          console.warn(
            "⚠️ La cita se canceló, pero no se pudo notificar al cliente:",
            err.message
          );
        }
      }

      const lineas = result.events
        .map(ev =>
          `• ${ev.summary || intent.nombre || "Visita técnica"} — ${ev.date || "fecha no disponible"}`
        )
        .join("\n");

      const plural = result.deleted > 1;

      return [
        `✅ *${plural ? `${result.deleted} citas canceladas` : "Cita cancelada"}*:`,
        ``,
        lineas,
        ``,
        intent.avisarCliente === false
          ? `🔕 Cliente NO notificado (como pediste).`
          : clienteNotificado
            ? `✉️ Cliente notificado automáticamente por WhatsApp.`
            : `ℹ️ La cita fue cancelada, pero no encontré un teléfono confiable para notificar automáticamente al cliente.`,
        `👤 Por: ${quien}`,
      ]
        .filter(Boolean)
        .join("\n");

    } catch (err) {
      console.error("❌ Error cancelando cita:", err.message);
      return `❌ Error al cancelar la cita: ${err.message}`;
    }
  }

  // ── REAGENDAR ───────────────────────────────────────────────────────────────
  if (intent.accion === "reagendar") {
    if (!intent.nombre && !intent.fecha) {
      return `⚠️ ¿Cuál cita muevo? Decime el nombre del cliente o la fecha actual.\n\nEjemplo:\n• *cambia la cita de Gabriela para el viernes a las 10*`;
    }
    if (!intent.nuevaFecha && !intent.nuevaHora) {
      return `⚠️ ¿Para cuándo la muevo? Indicá la nueva fecha u hora.\n\nEjemplo:\n• *mueve la cita de Gabriela para el 15 de julio a las 2pm*`;
    }
    try {
      const result = await rescheduleEventByNameAndDate({
        nameHint: intent.nombre,
        dateHint: intent.fecha,
        newDay:   intent.nuevaFecha,
        newHour:  intent.nuevaHora,
      });

      // calendar.js devuelve { updated, events, reason, conflict }
      // updated === 1 → reagenda realizada; updated === 0 → NO se modificó Calendar.
      if (result.updated !== 1) {

        if (result.reason === "not_found") {
          const q = intent.nombre
            ? ` de *${intent.nombre}*`
            : "";

          return [
            `📭 No encontré la cita${q} para mover.`,
            ``,
            `Verificá el nombre o la fecha actual e intentá de nuevo.`,
          ].join("\n");
        }

        if (result.reason === "error_calendario") {
          return [
            `❌ No se pudo reagendar la cita porque hubo un error consultando Google Calendar.`,
            ``,
            `⚠️ No voy a asumir que otra fecha está disponible.`,
            `Reintentá en unos minutos o revisá la agenda manualmente.`,
          ].join("\n");
        }

        if (
          result.reason === "dia_no_laborable" ||
          result.reason === "slot_ocupado" ||
          result.reason === "dia_bloqueado"
        ) {
          const rechazo = await formatearRechazoDisponibilidad(
            {
              reason: result.reason,
              conflict: result.conflict || null,
            },
            intent.nuevaFecha
          );

          return [
            `⚠️ *No se pudo reagendar la cita.*`,
            ``,
            rechazo,
          ].join("\n");
        }

        console.warn(
          "⚠️ Resultado inesperado al reagendar:",
          JSON.stringify(result)
        );

        return [
          `❌ No se pudo confirmar el reagendamiento.`,
          ``,
          `Google Calendar no confirmó que la cita haya sido modificada.`,
          `Revisá la agenda antes de informar una nueva fecha al cliente.`,
        ].join("\n");
      }

      const ev = result.events?.[0];

      if (!ev) {
        console.warn(
          "⚠️ Calendar reportó updated=1 pero no devolvió el evento reagendado."
        );

        return [
          `⚠️ Calendar indicó que la cita fue modificada,`,
          `pero no devolvió los datos necesarios para confirmar el cambio.`,
          ``,
          `Revisá el evento directamente en Google Calendar.`,
        ].join("\n");
      }

      const fechaNueva = ev.date instanceof Date
        ? ev.date
        : new Date(ev.date);

      const nuevaFechaStr =
        !isNaN(fechaNueva.getTime())
          ? fechaNueva.toLocaleDateString("es-CR", {
              timeZone: TZ,
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
            })
          : String(intent.nuevaFecha || "fecha actualizada");

      const nuevaHoraStr =
        !isNaN(fechaNueva.getTime())
          ? fechaNueva.toLocaleTimeString("es-CR", {
              timeZone: TZ,
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            })
          : String(intent.nuevaHora || "");

      // Buscamos el teléfono por nombre; sin teléfono confiable no se envía nada.
      let clienteNotificado = false;

      if (intent.avisarCliente !== false && intent.nombre) {
        try {
          const telefonoCliente = await buscarTelefonoClientePorNombre(intent.nombre);

          if (telefonoCliente && !SUPERVISORES.includes(telefonoCliente)) {
            const msgCliente = [
              `Hola, le escribimos de *SS Remodelaciones* 🏗️`,
              ``,
              `Su visita técnica fue *reprogramada*.`,
              ``,
              `📅 Nueva fecha: *${nuevaFechaStr}*`,
              nuevaHoraStr
                ? `🕐 Nueva hora: *${nuevaHoraStr}*`
                : "",
              ``,
              `Si tiene alguna consulta, con gusto le atendemos. ¡Hasta pronto! 😊`,
            ]
              .filter(Boolean)
              .join("\n");

            await sendText(telefonoCliente, msgCliente);
            clienteNotificado = true;
          }

        } catch (err) {
          console.warn(
            "⚠️ La cita se reagendó, pero no se pudo notificar al cliente:",
            err.message
          );
        }
      }

      return [
        `✅ *Cita reagendada*`,
        ``,
        `📋 ${ev.summary || intent.nombre || "Visita técnica"}`,
        `📅 Nueva fecha: *${nuevaFechaStr}*`,
        nuevaHoraStr
          ? `🕐 Nueva hora: *${nuevaHoraStr}*`
          : "",
        ``,
        intent.avisarCliente === false
          ? `🔕 Cliente NO notificado (como pediste).`
          : clienteNotificado
            ? `✉️ Cliente notificado automáticamente por WhatsApp.`
            : `ℹ️ La cita se reagendó, pero no encontré un teléfono confiable para notificar automáticamente al cliente.`,
        `👤 Por: ${quien}`,
      ]
        .filter(Boolean)
        .join("\n");

    } catch (err) {
      console.error("❌ Error reagendando cita:", err.message);
      return `❌ Error al reagendar la cita: ${err.message}`;
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// v21 — CANCELACIÓN AUTOMÁTICA DE VISITA POR EL PROPIO CLIENTE
// Solo frases inequívocas de cancelación. Calendar es la fuente de verdad.
// ═══════════════════════════════════════════════════════════════════════════════

// v25 — Teléfono con el que la visita del cliente está en Google Calendar.
// WhatsApp → su propio número. Instagram/Messenger → el WhatsApp que dio al
// agendar (whatsapp_contacto); si no lo dio, null.
function telefonoAgendaCliente(fromE164, session) {
  if (/^(ig|fb)_/i.test(String(fromE164 || ""))) return session?.whatsapp_contacto || null;
  return fromE164;
}

// v25 — El cliente habla de una visita que YA tiene (no pide agendar una).
// Ej.: "tengo una visita programada para el lunes 28", "mi cita del viernes",
// "quiero cambiar mi visita". Estos mensajes NO deben entrar al flujo de
// disponibilidad (antes "lunes 28" se tomaba como pedido de fecha nueva y
// terminaba agendando una segunda visita).
function clienteHablaDeVisitaExistente(texto) {
  const n = String(texto || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
  if (!n) return false;
  if (/\b(tengo|tenia|tenemos|mi|nuestra)\s+(una\s+)?(visita|cita)\b/.test(n)) return true;
  if (/\b(visita|cita)\s+(ya\s+)?(programada|agendada|reservada|confirmada)\b/.test(n)) return true;
  if (/\b(reprogram|reagend|cambiar|mover|posponer|adelantar)\w*\b.*\b(visita|cita)\b/.test(n)) return true;
  if (/\b(visita|cita)\b.*\b(reprogram|reagend|cambiar|mover|posponer|adelantar)\w*\b/.test(n)) return true;
  return false;
}

function clientePideCancelarVisita(texto) {
  const n = String(texto || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

  if (!n) return false;

  const accionCancelar =
    /\b(cancel|cancela|cancelar|cancele|cancelarla|cancelelo|cancelen|anul|elimin|borr|quit)\w*\b/.test(n);

  if (!accionCancelar) return false;

  const hablaDeVisita =
    /\b(cita|visita|reserv|agenda|agendamiento|evento)\w*\b/.test(n);

  const cancelacionDirecta =
    /\b(cancela|cancele|cancelarla|cancelalo|cancelela|anulala|anulelo|borrela|eliminala)\b/.test(n);

  return hablaDeVisita || cancelacionDirecta;
}

// ═══════════════════════════════════════════════════════════════════════════════
// v22 — NOMBRE Y DATOS DEL CLIENTE (respaldo determinístico)
// ═══════════════════════════════════════════════════════════════════════════════

// Palabras donde se corta un nombre ("me llamo carlos y quiero..." → "Carlos").
const CORTE_NOMBRE = new Set([
  "y", "e", "o", "que", "quiero", "quisiera", "necesito", "tengo", "para", "por",
  "con", "del", "en", "busco", "estoy", "me", "le", "les", "mi", "su", "es",
  "soy", "vivo", "desde", "sobre", "a", "al", "gracias", "buenas", "buenos",
  "hola", "saludos", "pura", "vida",
]);

// Palabras que nunca son un nombre ("Soy Ingeniero", "Soy Cliente").
const NO_NOMBRES = new Set([
  "cliente", "clienta", "ingeniero", "ingeniera", "arquitecto", "arquitecta",
  "dueño", "dueña", "propietario", "propietaria", "maestro", "contratista",
  "interesado", "interesada", "nuevo", "nueva", "yo", "de", "la", "el", "un", "una",
  "sasha", "costarricense", "tico", "tica", "administrador", "administradora",
]);

function capitalizarPalabra(p) {
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

function limpiarNombreCandidato(bruto) {
  const palabras = String(bruto || "")
    .replace(/[^A-Za-zÁÉÍÓÚÑÜáéíóúñü\s'-]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const nombre = [];
  for (const p of palabras) {
    if (CORTE_NOMBRE.has(p.toLowerCase())) break;
    nombre.push(capitalizarPalabra(p));
    if (nombre.length === 3) break;
  }

  if (!nombre.length) return null;
  if (NO_NOMBRES.has(nombre[0].toLowerCase())) return null;
  if (nombre.join(" ").length < 2) return null;
  return nombre.join(" ");
}

// Detecta un nombre DECLARADO explícitamente por el cliente. No adivina:
// solo reconoce "me llamo X", "mi nombre es X", "Soy X" (con mayúscula, al
// inicio o tras un saludo) y el formulario automático de Meta ("Full name:").
function extraerNombreDeclarado(texto) {
  const t = String(texto || "").trim();
  if (!t) return null;

  let m = t.match(/full name:\s*([^\n\r]+)/i);
  if (m) return limpiarNombreCandidato(m[1]);

  m = t.match(/\b(?:me llamo|mi nombre es|mi nombre:)\s+([A-Za-zÁÉÍÓÚÑÜáéíóúñü][A-Za-zÁÉÍÓÚÑÜáéíóúñü\s'-]{1,60})/i);
  if (m) return limpiarNombreCandidato(m[1]);

  m = t.match(/(?:^|[.!?¡,]\s*|\b(?:hola|buenas|buenos d[ií]as|buenas tardes|buenas noches)[,!.\s]+)soy\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñü]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñü]+){0,2})/i);
  if (m && /^[A-ZÁÉÍÓÚÑ]/.test(m[1])) return limpiarNombreCandidato(m[1]);

  return null;
}

// Cuenta los mensajes reales del cliente en el historial de la sesión.
function contarMensajesCliente(session) {
  const history = Array.isArray(session?.history) ? session.history : [];
  return history.filter(m =>
    m && m.role === "user" &&
    !(typeof m.content === "string" && m.content.startsWith("[SISTEMA"))
  ).length;
}

// Construye el [SISTEMA:...] con los datos guardados del cliente. Desde el 2º
// mensaje, si falta nombre/proyecto/zona, le recuerda a Claude emitir
// [LEAD:...] con lo que ya sepa. Si falta el nombre, le ordena pedirlo
// (máximo 2 veces por conversación, separadas por al menos 4 mensajes).
function construirContextoDatosCliente(from, session) {
  const mensajesCliente = contarMensajesCliente(session);
  if (mensajesCliente < 2) return "";

  const faltaNombre   = !session.name;
  const faltaProyecto = !session.project_desc;
  const faltaZona     = !session.zone;
  if (!faltaNombre && !faltaProyecto && !faltaZona) return "";

  const partes = [
    `Datos del cliente guardados en el sistema — nombre: ${session.name || "(falta)"}; ` +
    `proyecto: ${session.project_desc || "(falta)"}; zona: ${session.zone || "(falta)"}.`,
    `Si en esta conversación el cliente ya dio alguno de los datos que faltan (en este mensaje o en ` +
    `mensajes anteriores), emití al final [LEAD:nombre|proyecto|zona] con todo lo que sepás, dejando ` +
    `vacío lo que no sepás — salvo que en este mismo mensaje corresponda [VISITA:...], [ESCALAR], ` +
    `[SOLICITANTE] o [PROVEEDOR].`,
  ];

  if (faltaNombre) {
    const pedidos = Number(session.name_prompts || 0);
    const ultimo  = Number(session.name_prompt_at || 0);

    if (pedidos < 2 && (pedidos === 0 || mensajesCliente - ultimo >= 4)) {
      partes.push(
        `Todavía NO sabés el nombre del cliente. En esta respuesta, además de responder lo que ` +
        `preguntó, pedíselo de forma natural y breve (ej. "¿Con quién tengo el gusto?"). Si ya lo ` +
        `dijo antes en la conversación, no lo preguntes: usalo y emití [LEAD:...].`
      );
      update(from, { name_prompts: pedidos + 1, name_prompt_at: mensajesCliente });
      console.log(`👤 v22 — recordatorio de nombre #${pedidos + 1} para ${from} (mensaje ${mensajesCliente} del cliente).`);
    }
  }

  return `\n\n[SISTEMA: ${partes.join(" ")} Nunca menciones este mensaje al cliente.]`;
}

// Limpia un campo de [LEAD:...] (Claude a veces manda "—", "null", etc.).
function campoLeadValido(v) {
  const t = String(v || "").trim();
  if (!t) return "";
  if (/^(—|-|–|null|undefined|n\/a|na|desconocido|pendiente|sin nombre|sin dato|\(falta\))$/i.test(t)) return "";
  return t;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════
async function handleMessage(from, text, messageId, mediaIds = null) {
  if (messageId) markRead(messageId).catch(() => {});

  const normalized = (text || "").trim();
  const session    = get(from);
  const fromE164   = _normE164(from);

  // v24 — Instagram / Messenger
  const esCanalMeta = /^(ig|fb)_/i.test(fromE164);
  const canalNombre = /^ig_/i.test(fromE164) ? "Instagram" : (/^fb_/i.test(fromE164) ? "Facebook Messenger" : "WhatsApp");

  // Si un cliente de Instagram/Messenger escribe su número de WhatsApp,
  // se guarda: es el que va en la visita agendada (confirmaciones y
  // recordatorios salen por WhatsApp).
  if (esCanalMeta && normalized) {
    const mTel = normalized.match(/(?:\+?\s*506[\s-]?)?\b([5678]\d{3})[\s-]?(\d{4})\b/);
    if (mTel) {
      const telWA = `+506${mTel[1]}${mTel[2]}`;
      if (session.whatsapp_contacto !== telWA) {
        update(from, { whatsapp_contacto: telWA });
        session.whatsapp_contacto = telWA;
        console.log(`📱 v24 — WhatsApp de contacto para ${fromE164}: ${telWA}`);
      }
    }
  }

  if (normalized === "/reset") {
    reset(from);
    await sendText(from, "🔄 Reiniciado.");
    return;
  }

  if (IGNORAR.includes(fromE164) || IGNORAR.includes(from)) return;

  if (IGNORAR_PREFIJOS.some(p => fromE164.startsWith(p) || from.startsWith(p))) {
    console.log(`🚫 Mensaje bloqueado de país restringido: ${from}`);
    return;
  }

  // ══════════════════════════════════════════════════════════════════════
  // v18 — CONFIRMACIÓN DE VISITA (botones Sí/No del recordatorio de las 7pm)
  // Se revisa antes de cualquier otro procesamiento.
  // ══════════════════════════════════════════════════════════════════════
  if (normalized) {
    const manejadaConfirmacion = await manejarRespuestaConfirmacion(from, normalized);
    if (manejadaConfirmacion) return;
  }

  // ── MODO SUPERVISOR ──────────────────────────────────────────────────────────
  const esSupervisor =
    SUPERVISORES.includes(fromE164) ||
    SUPERVISORES.includes(from);

  // ═════════════════════════════════════════════════════════════════════════════
  // SASHA ASISTENCIA V1
  // Trabajadores SSR → Entrada / Salida / Selección de proyecto
  // Los supervisores conservan primero su funcionamiento administrativo normal.
  // ═════════════════════════════════════════════════════════════════════════════

  if (!esSupervisor && !esCanalMeta) {

    const telefonoAsistencia = String(from || "")
      .replace(/\D/g, "");

    try {

      // ── NÚMERO TEMPORAL DE PRUEBA COMO CLIENTE ──────────────────────
      // +50670068477 existe como trabajador SSR, pero durante las pruebas
      // debe saltarse Asistencia y continuar por el flujo comercial.
      const ES_CLIENTE_PRUEBA =
        telefonoAsistencia === "50670068477";

      const verificacion = ES_CLIENTE_PRUEBA
        ? { esTrabajador: false }
        : await esTrabajadorSSR(telefonoAsistencia);

      // Si hubo error consultando Apps Script NO lo tratamos como cliente.
      if (
        verificacion &&
        verificacion.error === true
      ) {

        console.error(
          `❌ SASHA ASISTENCIA — no se pudo verificar trabajador ${telefonoAsistencia}:`,
          verificacion.motivo || "error desconocido"
        );

        await sendText(
          from,
          "⚠️ No pude verificar tu estado de asistencia en este momento. Intentá nuevamente en unos segundos."
        );

        return;
      }

      // ── ES TRABAJADOR ──────────────────────────────────────────────
      if (
        verificacion &&
        verificacion.esTrabajador === true
      ) {

        console.log(
          `👷 SASHA ASISTENCIA — trabajador reconocido: ${telefonoAsistencia}`
        );

        // Foto de asistencia: se conserva el mediaId para reenviarla a
        // Darwin y se descarga en Base64 para que Claude valide el gesto.
        const fotoAsistencia =
          Array.isArray(mediaIds)
            ? (mediaIds[0] || "")
            : (mediaIds || "");

        let imagenAsistencia = null;

        if (fotoAsistencia) {

          try {

            console.log(
              `📥 SASHA ASISTENCIA — descargando fotografía: ${fotoAsistencia}`
            );

            imagenAsistencia =
              await downloadMedia(fotoAsistencia);

            if (
              imagenAsistencia &&
              imagenAsistencia.base64 &&
              imagenAsistencia.mimeType
            ) {

              console.log(
                `✅ SASHA ASISTENCIA — fotografía descargada correctamente | ${imagenAsistencia.mimeType}`
              );

            } else {

              console.warn(
                "⚠️ SASHA ASISTENCIA — downloadMedia no devolvió una imagen válida."
              );

              imagenAsistencia = null;
            }

          } catch (err) {

            console.error(
              "❌ SASHA ASISTENCIA — error descargando fotografía:",
              err.message
            );

            imagenAsistencia = null;
          }
        }

        const resultadoAsistencia =
          await procesarAsistencia({
            telefono: telefonoAsistencia,
            texto: normalized,
            foto: fotoAsistencia,
            imagen: imagenAsistencia,
            messageId: messageId || "",
            // v4 — reutilizar el estado que esTrabajadorSSR() ya consultó.
            estadoPrevio: verificacion.estado || null
          });

        console.log(
          "👷 SASHA ASISTENCIA — resultado:",
          JSON.stringify(resultadoAsistencia)
        );

        if (resultadoAsistencia) {

          const mensajeAsistencia =
            typeof resultadoAsistencia === "string"
              ? resultadoAsistencia
              : (
                  resultadoAsistencia.mensaje ||
                  resultadoAsistencia.respuesta ||
                  ""
                );

          if (mensajeAsistencia) {

            console.log(
              `📤 SASHA ASISTENCIA — enviando respuesta a ${telefonoAsistencia}: ${mensajeAsistencia}`
            );

            await sendText(
              from,
              mensajeAsistencia
            );

          } else {

            console.warn(
              "⚠️ SASHA ASISTENCIA procesó el mensaje pero no devolvió texto:",
              JSON.stringify(resultadoAsistencia)
            );
          }

          // ── Notificación a Darwin: solo movimientos confirmados ──────
          const tipoAsistencia =
            typeof resultadoAsistencia === "object"
              ? resultadoAsistencia.tipo
              : "";

          const tiposNotificables = [
            "entrada_registrada",
            "salida_registrada",
            "proyecto_asignado"
          ];

          if (
            tiposNotificables.includes(tipoAsistencia)
          ) {

            let mensajeDarwin = "";

            const trabajador =
              resultadoAsistencia.trabajador ||
              "Trabajador";

            const proyecto =
              resultadoAsistencia.etiquetaProyecto ||
              resultadoAsistencia.proyectoEtiqueta ||
              resultadoAsistencia.proyecto ||
              (
                resultadoAsistencia.jornada &&
                resultadoAsistencia.jornada.proyecto
              ) ||
              "Sin proyecto";

            // ENTRADA / PROYECTO ASIGNADO
            if (
              tipoAsistencia === "entrada_registrada" ||
              tipoAsistencia === "proyecto_asignado"
            ) {

              const hora =
                resultadoAsistencia.hora ||
                resultadoAsistencia.entrada ||
                "";

              mensajeDarwin =
                `📥 *ASISTENCIA — ENTRADA*\n\n` +
                `👷 ${trabajador}\n` +
                `🏗️ ${proyecto}\n` +
                (hora
                  ? `🕐 Entrada: ${hora}\n`
                  : "") +
                `📸 Fotografía registrada`;
            }

            // SALIDA — REPORTE COMPLETO
            if (
              tipoAsistencia === "salida_registrada"
            ) {

              const entrada =
                resultadoAsistencia.entrada ||
                (
                  resultadoAsistencia.jornada &&
                  resultadoAsistencia.jornada.entrada
                ) ||
                "";

              const salida =
                resultadoAsistencia.salida ||
                resultadoAsistencia.hora ||
                "";

              const horasHoy =
                resultadoAsistencia.horasHoyTexto ||
                resultadoAsistencia.resultado?.horasHoyTexto ||
                (
                  resultadoAsistencia.horas !== undefined &&
                  resultadoAsistencia.horas !== null
                    ? String(resultadoAsistencia.horas)
                    : ""
                );

              const horasSemana =
                resultadoAsistencia.horasSemanaTexto ||
                resultadoAsistencia.resultado?.horasSemanaTexto ||
                "";

              const pagoSemana =
                resultadoAsistencia.pagoSemanaTexto ||
                resultadoAsistencia.resultado?.pagoSemanaTexto ||
                "";

              mensajeDarwin =
                `📋 *REPORTE DE SALIDA — SUPERVISIÓN*\n\n` +
                `👷 ${trabajador}\n` +
                `🏗️ ${proyecto}\n\n` +
                (entrada
                  ? `🕐 Entrada: ${entrada}\n`
                  : "") +
                (salida
                  ? `🕔 Salida: ${salida}\n\n`
                  : "\n") +
                (horasHoy
                  ? `⏱️ Horas laboradas hoy: ${horasHoy}\n`
                  : "") +
                (horasSemana
                  ? `📊 Horas acumuladas en la semana: ${horasSemana}\n`
                  : "") +
                (pagoSemana
                  ? `💰 Pago acumulado de la semana: ${pagoSemana}\n`
                  : "") +
                `\n🧾 Monto acumulado antes de vales.\n` +
                `📸 Fotografía registrada`;
            }

            if (mensajeDarwin) {

              try {

                await sendText(
                  DARWIN_PHONE,
                  mensajeDarwin
                );

                if (fotoAsistencia) {

                  console.log(
                    `📸 SASHA ASISTENCIA — reenviando fotografía a Darwin: ${fotoAsistencia}`
                  );

                  await sendMediaById(
                    DARWIN_PHONE,
                    fotoAsistencia
                  );

                } else {

                  console.warn(
                    "⚠️ SASHA ASISTENCIA — movimiento registrado sin fotografía disponible para reenviar."
                  );

                }

              } catch (err) {

                console.warn(
                  "⚠️ No se pudo enviar notificación/fotografía de asistencia a Darwin:",
                  err.message
                );

              }
            }

          }

          // Trabajador: SIEMPRE termina aquí, nunca pasa al flujo comercial.
          return;
        }

        console.warn(
          `⚠️ Trabajador reconocido pero Asistencia no devolvió resultado: ${telefonoAsistencia}`
        );

        return;
      }

      // ── NO ES TRABAJADOR → continúa al flujo comercial ─────────────
      console.log(
        `👤 SASHA — ${telefonoAsistencia} no es trabajador SSR; continúa flujo comercial.`
      );

    } catch (err) {

      // FAIL CLOSED: si Asistencia falla, no mandamos a la persona al
      // flujo comercial.
      console.error(
        "❌ Error en SASHA ASISTENCIA:",
        err?.message || err
      );

      await sendText(
        from,
        "⚠️ No pude verificar la asistencia en este momento. Intentá nuevamente en unos segundos."
      ).catch(() => {});

      return;
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // FIN SASHA ASISTENCIA V1
  // ═════════════════════════════════════════════════════════════════════════════

  // ── v4/v8/v18: lectura de comprobantes bancarios por imagen (supervisores) ──
  if (esSupervisor && mediaIds) {
    const idsComprobante = Array.isArray(mediaIds) ? mediaIds : [mediaIds];
    for (const id of idsComprobante) {
      try {
        const imgData = await downloadMedia(id);
        if (!imgData) continue;

        const contextoPrevio = consumirContextoPendiente(fromE164);
        let textoParaImagen = [contextoPrevio, normalized].filter(Boolean).join(". ").trim();

        if (!textoParaImagen) {
          const entry = agregarFotoPendiente(fromE164, imgData);

          await new Promise(resolve => setTimeout(resolve, PENDING_PHOTO_WAIT_MS));

          const seguiaPendiente = quitarFotoPendiente(fromE164, entry);
          if (!seguiaPendiente) {
            // Un mensaje de texto ya la reclamó y la procesó combinada.
            continue;
          }

          textoParaImagen = consumirContextoPendiente(fromE164);
        }

        const respuestaComprobante = await procesarComprobanteImagen(imgData.base64, imgData.mimeType, textoParaImagen);

        if (respuestaComprobante && !respuestaComprobante.startsWith("📭")) {
          const respuestaLimpia = sanitizarRespuestaFinanciera(respuestaComprobante);
          await sendText(from, respuestaLimpia);
          await copiaFinancieraADarwin(fromE164, respuestaLimpia);
          return;
        }
      } catch (err) {
        console.error("❌ Error procesando imagen de comprobante:", err.message);
      }
    }
  }

  if (esSupervisor && normalized) {

    // FIX v3/v7: desenvolver instrucción de voz ANTES de evaluar comandos.
    const textoLimpio = desenvolverInstruccionVoz(normalized);

    // ── PASO 0.5 (v15): Consultas financieras de solo lectura ─────────────────
    if (esConsultaFinanciera(textoLimpio)) {
      const respuestaConsulta = await procesarConsultaFinanciera(textoLimpio);
      await sendText(from, respuestaConsulta);
      return;
    }

    // ── PASO 1 (v6/v18): Finanzas en lenguaje natural → DIRECTO a finanzas.js ─
    const cmd = normalized;

    if (!/^\[(GASTO|INGRESO):/i.test(cmd) && esComandoFinanciero(textoLimpio)) {

      // v18 — fusionar con una foto de comprobante pendiente.
      const fotoPendiente = tomarFotoPendienteMasAntigua(fromE164);
      if (fotoPendiente) {
        const respuestaComprobante = await procesarComprobanteImagen(
          fotoPendiente.imgData.base64,
          fotoPendiente.imgData.mimeType,
          textoLimpio
        );
        if (respuestaComprobante) {
          const respuestaLimpia = sanitizarRespuestaFinanciera(respuestaComprobante);
          await sendText(from, respuestaLimpia);
          await copiaFinancieraADarwin(fromE164, respuestaLimpia);
        }
        return;
      }

      // v8 — comando sin monto: esperar la foto del comprobante.
      if (esComandoFinancieroSinMonto(textoLimpio)) {
        guardarContextoPendiente(fromE164, textoLimpio);
        await sendText(from, "📌 Anotado. Mandame la foto del comprobante para completar el registro.");
        return;
      }

      const respuesta = await procesarComandoFinanciero(textoLimpio);
      if (respuesta) {
        const respuestaLimpia = sanitizarRespuestaFinanciera(respuesta);
        await sendText(from, respuestaLimpia);
        await copiaFinancieraADarwin(fromE164, respuestaLimpia);
        return;
      }
    }

    // ── PASO 2 (v7): Gestión de calendario — cancelar/reagendar/consultar ─────
    const respCalendario = await gestionarCalendarioSupervisor(textoLimpio, fromE164);
    if (respCalendario !== null) {
      await sendText(from, respCalendario);
      return;
    }

    // ── PASO 3: Comandos estructurados de supervisor ──────────────────────────

    if (/^\[GASTO:/i.test(cmd)) {
      const respuesta = await handleGasto(cmd, fromE164);
      await sendText(from, respuesta);
      await copiaFinancieraADarwin(fromE164, respuesta);
      return;
    }

    if (/^\[INGRESO:/i.test(cmd)) {
      const respuesta = await handleIngreso(cmd, fromE164);
      await sendText(from, respuesta);
      await copiaFinancieraADarwin(fromE164, respuesta);
      return;
    }

    if (/^\[MSG_CLIENTE:/i.test(cmd)) {
      const respuesta = await handleMsgCliente(cmd, fromE164);
      await sendText(from, respuesta);
      return;
    }

    if (/^\[VISITA:/i.test(cmd)) {
      const respuesta = await handleVisitaSupervisor(cmd, fromE164);
      await sendText(from, respuesta);
      return;
    }

    if (/^\[RESUMEN_CLIENTE:/i.test(cmd)) {
      const nombre   = cmd.replace(/^\[RESUMEN_CLIENTE:\s*/i, "").replace(/\]$/, "").trim();
      const busqueda = `resumen de ${nombre}`;
      const respuesta = await memoria.procesarConsultaMemoria(busqueda);
      await sendText(from, respuesta || `📭 No encontré conversaciones de "${nombre}".`);
      return;
    }

    // ── PASO 4: Consultas de memoria (lenguaje natural) ───────────────────────
    const respuestaMemoria = await memoria.procesarConsultaMemoria(cmd);
    if (respuestaMemoria) {
      await sendText(from, respuestaMemoria);
      return;
    }

    // ── PASO 5: Si nada matcheó, cae al flujo normal de Sasha ─────────────────
  }

  if (session.escalated) return;

  // ── MODO SOLICITANTE DE TRABAJO ──────────────────────────────────────────────
  if (session.modo === "solicitante") {
    await handleRRHHFlow(from, normalized, session, "solicitante");
    return;
  }

  // ── MODO PROVEEDOR ───────────────────────────────────────────────────────────
  if (session.modo === "proveedor") {
    await handleRRHHFlow(from, normalized, session, "proveedor");
    return;
  }

  try {
    // ── Descargar imágenes ────────────────────────────────────────────────────
    let imageDataArray = [];
    if (mediaIds) {
      const ids = Array.isArray(mediaIds) ? mediaIds : [mediaIds];
      console.log(`🖼️ Descargando ${ids.length} imagen(es) de ${from}...`);
      const results = await Promise.allSettled(ids.map(id => downloadMedia(id)));
      imageDataArray = results
        .map((r, i) => {
          if (r.status === "fulfilled" && r.value) {
            console.log(`✅ Imagen ${i + 1}/${ids.length} (${r.value.mimeType})`);
            return r.value;
          }
          console.error(`❌ Error img ${i + 1}:`, r.reason?.message);
          return null;
        })
        .filter(Boolean);
    }

    const imageData = imageDataArray.length === 0 ? null
      : imageDataArray.length === 1 ? imageDataArray[0]
      : imageDataArray;

    if (!normalized && imageDataArray.length === 0) return;

    const historyText = normalized ||
      (imageDataArray.length === 1 ? "[Cliente envió una foto]" : `[Cliente envió ${imageDataArray.length} fotos]`);

    addMsg(from, "user", historyText);

    // ══════════════════════════════════════════════════════════════════════
    // v22 — NOMBRE DECLARADO POR EL CLIENTE (sin depender de Claude)
    // "me llamo X" / "mi nombre es X" / "Soy X" / formulario de Meta. Se
    // guarda ANTES de registrar el mensaje en memoria, para que esta misma
    // fila ya salga con el nombre en el CRM.
    // ══════════════════════════════════════════════════════════════════════
    if (!esSupervisor && normalized && !session.name) {
      const nombreDeclarado = extraerNombreDeclarado(normalized);
      if (nombreDeclarado) {
        Object.assign(session, update(from, { name: nombreDeclarado }) || { name: nombreDeclarado });
        console.log(`👤 v22 — nombre declarado por ${fromE164}: "${nombreDeclarado}"`);
        memoria.actualizarNombreInmediato(fromE164, nombreDeclarado, {
          proyecto: session.project_desc || "",
          zona:     session.zone || "",
        }).catch(() => {});
      }
    }

    // ── Guardar en memoria ────────────────────────────────────────────────────
    if (!esSupervisor) {
      const clientName = session.name || null;
      if (normalized) {
        memoria.guardarMensaje({ phone: fromE164, clientName, direction: "in", type: "text", content: normalized, session }).catch(() => {});
      }
      if (imageDataArray.length > 0) {
        const ids = Array.isArray(mediaIds) ? mediaIds : [mediaIds];
        imageDataArray.forEach((imgData, i) => {
          const mediaId = ids[i] || "";
          memoria.guardarMedia(Buffer.from(imgData.base64, "base64"), imgData.mimeType, fromE164, clientName)
            .then(driveUrl => {
              if (!driveUrl) {
                console.warn(`⚠️ Memoria: foto de ${fromE164} (mediaId ${mediaId}) guardada SIN driveUrl — revisar el error de guardarMedia arriba en este mismo log.`);
              }
              return memoria.guardarMensaje({ phone: fromE164, clientName, direction: "in", type: "image", content: "[Foto enviada por el cliente]", mediaId, driveUrl: driveUrl || "", session }).catch(() => {});
            })
            .catch(err => {
              console.error(`❌ Memoria: guardarMedia rechazó la promesa para ${fromE164} (mediaId ${mediaId}):`, err.message);
              return memoria.guardarMensaje({ phone: fromE164, clientName, direction: "in", type: "image", content: "[Foto enviada por el cliente]", mediaId, driveUrl: "", session }).catch(() => {});
            });
        });
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // v19 — PAUSA MANUAL: Darwin tomó el control de ESTA conversación desde
    // el CRM. El mensaje ya quedó guardado en memoria arriba, pero Sasha no
    // responde mientras dure la pausa (solo para este teléfono).
    // ══════════════════════════════════════════════════════════════════════
    if (!esSupervisor && estaEnPausaManual(fromE164)) {
      console.log(`⏸️ Conversación con ${fromE164} en pausa manual (Darwin tiene el control) — Sasha no responde.`);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // v21 — CANCELACIÓN AUTOMÁTICA SOLICITADA POR EL CLIENTE
    // Sasha solo confirma "cancelada" después de que Calendar lo confirme.
    // ══════════════════════════════════════════════════════════════════════
    // v25 — si se le pidió el WhatsApp para cancelar y ahora lo manda, se
    // retoma la cancelación sin que tenga que repetir "cancelar".
    const retomaCancelacion =
      esCanalMeta &&
      !!session.cancelacion_pendiente &&
      Date.now() - Number(session.cancelacion_pendiente) < 30 * 60 * 1000 &&
      !!session.whatsapp_contacto &&
      /\d{4}[\s-]?\d{4}/.test(normalized || "");

    if (
      !esSupervisor &&
      normalized &&
      (clientePideCancelarVisita(normalized) || retomaCancelacion)
    ) {
      if (session.cancelacion_pendiente) update(from, { cancelacion_pendiente: null });
      console.log(
        `🗑️ Cancelación solicitada por cliente ${fromE164}: "${normalized}"`
      );

      // v25 — Instagram/Messenger: la visita está con su WhatsApp, no con el id ig_/fb_.
      const telefonoAgenda = telefonoAgendaCliente(fromE164, session);

      if (!telefonoAgenda) {
        const pideNumero =
          "Con gusto le ayudo a cancelar su visita 😊. ¿Me confirma el número de WhatsApp " +
          "que usó al agendarla? Así la ubico en nuestra agenda.";
        await sendText(from, pideNumero);
        addMsg(from, "assistant", pideNumero);
        update(from, { cancelacion_pendiente: Date.now() });
        console.log(`🗑️ v25 — Cancelación desde ${fromE164} sin WhatsApp de contacto: se le pidió el número.`);
        return;
      }

      try {
        const resultadoCancelacion =
          await cancelClientVisitByPhone(telefonoAgenda);

        console.log(
          "📅 Resultado cancelación cliente:",
          JSON.stringify(resultadoCancelacion)
        );

        // ── CANCELACIÓN CONFIRMADA POR GOOGLE CALENDAR ───────────────────
        if (
          resultadoCancelacion &&
          resultadoCancelacion.success === true &&
          resultadoCancelacion.deleted === 1
        ) {
          const eventoCancelado =
            resultadoCancelacion.event ||
            (Array.isArray(resultadoCancelacion.events)
              ? resultadoCancelacion.events[0]
              : null);

          update(from, {
            visit_confirmed: false,
            visit_day: null,
            visit_hour: null,
            agenda_selected_date: null,
            slots_shown: null,
          });

          const mensajeCancelada = [
            "✅ Su visita quedó cancelada correctamente.",
            "",
            "La cita ya fue eliminada de nuestra agenda.",
            "Cuando desee retomarla, con mucho gusto podemos mostrarle nuevamente las fechas disponibles. 😊",
          ].join("\n");

          await sendText(from, mensajeCancelada);
          addMsg(from, "assistant", mensajeCancelada);

          memoria.guardarMensaje({
            phone: fromE164,
            clientName: session.name || null,
            direction: "out",
            type: "text",
            content: mensajeCancelada,
            session: get(from),
          }).catch(() => {});

          console.log(
            `✅ Visita cancelada realmente en Calendar para ${fromE164}` +
            (eventoCancelado?.summary
              ? ` — ${eventoCancelado.summary}`
              : "")
          );

          return;
        }

        // ── MÁS DE UNA CITA: nunca borrar varias automáticamente ────────
        if (
          resultadoCancelacion &&
          (
            resultadoCancelacion.reason === "multiple" ||
            resultadoCancelacion.reason === "multiple_events" ||
            resultadoCancelacion.reason === "multiple_matches" ||
            resultadoCancelacion.ambiguous === true
          )
        ) {
          await sendText(
            from,
            "Encontré más de una visita futura asociada a su número. Para evitar cancelar una cita incorrecta, necesito que nuestro equipo revise cuál desea eliminar."
          );

          console.warn(
            `⚠️ Cancelación ambigua para ${fromE164}; no se eliminó ninguna cita.`
          );

          return;
        }

        // ── NO SE ENCONTRÓ CITA ────────────────────────────────────────
        if (
          resultadoCancelacion &&
          resultadoCancelacion.reason === "not_found"
        ) {
          await sendText(
            from,
            esCanalMeta
              ? `No encontré una visita futura agendada con el WhatsApp ${telefonoAgenda}. No eliminé nada de la agenda. ¿La agendó con otro número? Si me lo indica, la busco.`
              : "No encontré una visita futura activa asociada a este número de WhatsApp. No eliminé ningún evento de la agenda."
          );

          console.warn(
            `📭 Cliente ${fromE164} pidió cancelar, pero Calendar no encontró una cita futura.`
          );

          return;
        }

        // ── RESPUESTA INESPERADA DEL BACKEND ───────────────────────────
        await sendText(
          from,
          "No pude completar la cancelación en la agenda en este momento. Su cita no se considera cancelada todavía. Por favor inténtelo nuevamente o permítame escalarlo con nuestro equipo."
        );

        console.error(
          `❌ Cancelación NO confirmada para ${fromE164}:`,
          resultadoCancelacion
        );

        return;

      } catch (err) {
        console.error(
          `❌ Error cancelando visita del cliente ${fromE164}:`,
          err.message,
          err.stack
        );

        await sendText(
          from,
          "No pude completar la cancelación en Google Calendar en este momento. Su cita sigue activa hasta que podamos confirmar la eliminación. Por favor inténtelo nuevamente en unos minutos."
        );

        return;
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // v20 — RESPUESTA A LISTA INTERACTIVA DE AGENDA (agenda_fecha_YYYY-MM-DD)
    // El backend extrae la fecha y revalida Calendar; Claude no interviene.
    // ══════════════════════════════════════════════════════════════════════
    const fechaAgendaSeleccionada = extraerFechaAgendaInteractiva(normalized);

    if (fechaAgendaSeleccionada) {
      try {
        console.log(
          `📅 Agenda interactiva — ${fromE164} seleccionó ${fechaAgendaSeleccionada}. Revalidando Calendar...`
        );

        const sigueDisponible = await fechaSigueDisponibleAgenda(
          fechaAgendaSeleccionada
        );

        if (!sigueDisponible) {
          console.warn(
            `⛔ Agenda interactiva — ${fechaAgendaSeleccionada} ya no está disponible para ${fromE164}.`
          );

          await sendText(
            from,
            "Disculpe 🙏 Esa fecha acaba de dejar de estar disponible. Le muestro las opciones que siguen libres:"
          );

          await enviarListaFechasAgenda(from, {
            daysAhead: 35,
            maxDates: 10,
            texto: "Estas son las fechas disponibles actualmente:",
          });

          return;
        }

        const fechaLegible = capitalizarAgenda(
          fechaISOaLegibleAgenda(fechaAgendaSeleccionada)
        );

        update(from, {
          agenda_selected_date: fechaAgendaSeleccionada,
          visit_day:            fechaAgendaSeleccionada,
          visit_hour:           "09:00",
          visit_confirmed:      false,
          slots_shown:          fechaAgendaSeleccionada,
        });

        const seleccionHumana =
          `El cliente seleccionó la fecha ${fechaLegible} a las 9:00 a.m. de las opciones verificadas por el sistema.`;

        addMsg(from, "user", `[SISTEMA AGENDA: ${seleccionHumana}]`);

        const sesionActual = get(from);

        const datosFaltantes = [];

        if (!sesionActual.name) {
          datosFaltantes.push("su nombre");
        }

        if (!sesionActual.project_desc) {
          datosFaltantes.push("qué trabajo o remodelación necesita");
        }

        if (!sesionActual.zone) {
          datosFaltantes.push("la zona donde se realizará el trabajo");
        }

        if (!sesionActual.waze_link) {
          datosFaltantes.push("la ubicación o enlace de Waze");
        }

        if (!sesionActual.client_email) {
          datosFaltantes.push("su correo electrónico");
        }

        const siguientePregunta = datosFaltantes.length > 0
          ? `Para completar la visita todavía necesito ${datosFaltantes.join(", ")}.`
          : "Ya tengo los datos necesarios para completar la solicitud de visita.";

        const mensajeSeleccion = [
          `📅 Perfecto. Seleccionó *${fechaLegible} a las 9:00 a.m.*`,
          ``,
          `La fecha está disponible en este momento.`,
          siguientePregunta,
        ].join("\n");

        await sendText(from, mensajeSeleccion);
        addMsg(from, "assistant", mensajeSeleccion);

        if (!esSupervisor) {
          memoria.guardarMensaje({
            phone:      fromE164,
            clientName: session.name || null,
            direction:  "out",
            type:       "text",
            content:    mensajeSeleccion,
            session:    get(from),
          }).catch(() => {});
        }

        console.log(
          `✅ Agenda interactiva — ${fechaAgendaSeleccionada} sigue disponible. Selección guardada para ${fromE164}.`
        );

        return;

      } catch (err) {
        console.error(
          "❌ Error procesando selección de agenda interactiva:",
          err.message,
          err.stack
        );

        await sendText(
          from,
          "Disculpe, tuve un problema al verificar esa fecha en la agenda 🙏. Por favor inténtelo nuevamente."
        );

        return;
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // v20 — DISPONIBILIDAD REAL DE VISITAS (Google Calendar = fuente de verdad)
    // 1. Pregunta genérica → lista interactiva con fechas reales.
    // 2. Día/fecha no hábil → regla + fechas reales.
    // 3. Día/fecha hábil concreto → getAvailableSlots() verifica ese día.
    // ══════════════════════════════════════════════════════════════════════
    // v25 — "tengo una visita para el lunes 28" habla de una visita existente:
    // no se ofrece disponibilidad; Claude responde con la agenda real (v23).
    const hablaDeVisitaExistente = !esSupervisor && clienteHablaDeVisitaExistente(normalized);
    if (hablaDeVisitaExistente) {
      console.log(`📅 v25 — ${fromE164} habla de una visita existente; se omite el flujo de disponibilidad.`);
    }
    const dayMentioned = hablaDeVisitaExistente ? null : detectDayOrDate(normalized);
    let availabilityContext = "";

    if (dayMentioned === "GENERICO") {

      update(from, { slots_shown: "GENERICO" });

      try {
        const disponibilidad = await enviarListaFechasAgenda(from, {
          daysAhead: 35,
          maxDates: 10,
          texto: "Estas son las próximas fechas disponibles para una visita técnica:",
        });

        if (disponibilidad.ok) {
          console.log(
            `📅 Disponibilidad general enviada a ${fromE164}: ${disponibilidad.fechas.length} fecha(s) reales.`
          );
          return;
        }

        console.warn(
          `📭 Sin fechas disponibles para ${fromE164} en los próximos 35 días.`
        );
        return;

      } catch (err) {
        console.error(
          "❌ Error consultando disponibilidad general:",
          err.message
        );

        availabilityContext =
          `\n\n[SISTEMA: El cliente preguntó por disponibilidad para una visita, ` +
          `pero ocurrió un error técnico al consultar Google Calendar. ` +
          `NO inventes fechas ni horarios y NO afirmes que existe disponibilidad. ` +
          `Explícale brevemente que en este momento no pudiste consultar la agenda ` +
          `y que el equipo puede ayudarle a coordinar.]`;
      }

    } else if (dayMentioned) {

      update(from, { slots_shown: dayMentioned });

      const esNombreDiaNoHabil =
        NOMBRES_DIA_NO_HABIL.includes(dayMentioned);

      const infoFecha = esNombreDiaNoHabil
        ? null
        : calcularFechaYDiaSemana(dayMentioned);

      // ── CASO A — Día no hábil ──────────────────────────────────────────
      if (
        esNombreDiaNoHabil ||
        (infoFecha && !DIAS_HABILES.includes(infoFecha.diaSemana))
      ) {

        const detalleFecha = infoFecha
          ? `La fecha solicitada cae en ${infoFecha.diaSemana}.`
          : `${capitalizarAgenda(dayMentioned)} no es un día de visita.`;

        try {
          const disponibilidad = await enviarListaFechasAgenda(from, {
            daysAhead: 35,
            maxDates: 10,
            texto:
              `${detalleFecha} Las visitas se realizan lunes, martes y viernes. ` +
              `Estas son las próximas fechas realmente disponibles:`,
          });

          if (disponibilidad.ok) {
            console.log(
              `📅 Día no hábil solicitado por ${fromE164}; se enviaron alternativas reales.`
            );
          }

          return;

        } catch (err) {
          console.error(
            "❌ Error buscando alternativas para día no hábil:",
            err.message
          );

          availabilityContext =
            `\n\n[SISTEMA: El cliente pidió "${dayMentioned}", pero esa fecha/día ` +
            `no corresponde a los días de visita (lunes, martes y viernes). ` +
            `Además ocurrió un error al consultar las alternativas reales en ` +
            `Google Calendar. NO inventes ninguna fecha. Explica únicamente la ` +
            `regla de días de visita e indica que la agenda no pudo consultarse ` +
            `en este momento.]`;
        }

      } else {

        // ── CASO B — Día/fecha potencialmente hábil ──────────────────────
        try {
          const resultado = await getAvailableSlots(dayMentioned);

          const slots = Array.isArray(resultado?.slots)
            ? resultado.slots
            : [];

          const dateLabel =
            resultado?.dateLabel ||
            dayMentioned;

          const nHoyManana = normalized
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "");

          const preguntoHoyOManana =
            /\bhoy\b/.test(nHoyManana) ||
            /\bmanana\b/.test(nHoyManana);

          if (slots.length === 0) {

            console.log(
              `⛔ Fecha solicitada sin disponibilidad: ${dateLabel} — ${fromE164}`
            );

            try {
              const disponibilidad = await enviarListaFechasAgenda(from, {
                daysAhead: 35,
                maxDates: 10,
                texto:
                  `${capitalizarAgenda(dateLabel)} no está disponible. ` +
                  `Estas son las próximas fechas que sí están libres:`,
              });

              if (disponibilidad.ok) {
                console.log(
                  `📅 Se enviaron alternativas reales a ${fromE164}.`
                );
              }

              return;

            } catch (errAlternativas) {
              console.error(
                "❌ Error buscando alternativas reales:",
                errAlternativas.message
              );

              availabilityContext =
                `\n\n[SISTEMA: El cliente pidió ${dateLabel}, pero Google Calendar ` +
                `confirmó que esa fecha NO está disponible. Luego ocurrió un error ` +
                `consultando fechas alternativas. NO inventes ninguna fecha ni ` +
                `horario. Dile únicamente que esa fecha no está disponible y que ` +
                `el equipo puede ayudarle a revisar otra opción.]`;
            }

          } else {

            const slotsText = slots.map(slot => {
              const [h, m] = slot.split(":");
              const hNum = parseInt(h, 10);
              const h12 =
                hNum > 12
                  ? hNum - 12
                  : hNum === 0
                    ? 12
                    : hNum;

              return `${h12}:${m} ${hNum >= 12 ? "p.m." : "a.m."}`;
            }).join(", ");

            const notaHoyOManana = preguntoHoyOManana
              ? ` El cliente mencionó hoy/mañana. Las visitas NUNCA deben ` +
                `confirmarse para el mismo día de la solicitud. Usa exclusivamente ` +
                `la fecha exacta devuelta por Calendar: ${dateLabel}.`
              : "";

            availabilityContext =
              `\n\n[SISTEMA: Google Calendar acaba de verificar la disponibilidad. ` +
              `La fecha real disponible es *${dateLabel}*. ` +
              `Horario disponible: ${slotsText}. ` +
              `Esta información viene del backend y es la única fuente de verdad. ` +
              `NO calcules otra fecha, NO cambies el día y NO inventes horarios. ` +
              `Si el cliente quiere esa fecha, continúa recopilando los datos que ` +
              `falten para completar la visita. Todavía NO afirmes que la cita quedó ` +
              `agendada: eso solo puede decirse después de que createVisitEvent() ` +
              `confirme éxito.${notaHoyOManana}]`;

            console.log(
              `✅ Disponibilidad específica verificada para ${fromE164}: ${dateLabel} — ${slotsText}`
            );
          }

        } catch (err) {
          console.error(
            `❌ Error verificando "${dayMentioned}" en Calendar:`,
            err.message
          );

          availabilityContext =
            `\n\n[SISTEMA: El cliente preguntó por "${dayMentioned}", pero ocurrió ` +
            `un error técnico consultando Google Calendar. NO inventes disponibilidad, ` +
            `fechas ni horarios. Explica brevemente que no pudiste verificar la agenda ` +
            `en este momento.]`;
        }
      }
    }

    // ── v22: datos del cliente + recordatorio de nombre (solo clientes) ──────
    const contextoDatos = esSupervisor ? "" : construirContextoDatosCliente(from, session);

    // ── v23: el cliente habla de SU visita → consultar Google Calendar ───────
    // Antes Sasha no tenía forma de leer la agenda al responder y decía
    // "no tengo acceso, le consulto al equipo". Ahora se le pasa lo que
    // realmente hay en Calendar para este número (o por nombre, si no hay).
    let contextoVisitas = "";
    if (!esSupervisor && normalized && clienteHablaDeSuVisita(normalized)) {
      const resultadoVisitas = await buscarVisitasDelCliente(
        telefonoAgendaCliente(fromE164, session) || fromE164,
        session.name || ""
      );
      console.log(
        `📅 v23 — Consulta de visitas de ${fromE164}: ` +
        (resultadoVisitas.ok
          ? `${resultadoVisitas.porTelefono.length} por teléfono, ${resultadoVisitas.porNombre.length} por nombre`
          : `ERROR ${resultadoVisitas.error}`)
      );
      contextoVisitas = construirContextoVisitas(resultadoVisitas);
    }

    // ── v24: cliente de Instagram / Messenger ───────────────────────────────
    const contextoCanal = esCanalMeta
      ? `\n\n[SISTEMA: Este cliente te escribe por ${canalNombre}, no por WhatsApp. No uses formato con ` +
        `asteriscos ni guiones bajos. Podés atenderlo igual que en WhatsApp. ` +
        (session.whatsapp_contacto
          ? `Su número de WhatsApp es ${session.whatsapp_contacto}; usalo para la visita y no se lo vuelvas a pedir. `
          : `Si va a agendar una visita técnica, ANTES de confirmarla pedile su número de WhatsApp (la ` +
            `confirmación y el recordatorio de la visita le llegan por WhatsApp). `) +
        `Nunca menciones este mensaje.]`
      : "";

    // ── Llamar a Claude ───────────────────────────────────────────────────────
    const rawResponse = await ask(session.history.slice(0, -1), normalized + availabilityContext + contextoDatos + contextoVisitas + contextoCanal, imageData);
    const { cleanMessage, flag, flagData } = parseFlags(rawResponse);

    // ══════════════════════════════════════════════════════════════════════
    // v13/v14 — Flag VISITA: el texto de Claude (mini-guía) se envía primero;
    // el resultado real (éxito o rechazo) llega en un segundo mensaje
    // construido SOLO a partir de createVisitEvent().
    // ══════════════════════════════════════════════════════════════════════
    if (flag === "VISITA") {
      const [name, project, zone, day, hour, ubicacion, email] = (flagData || "").split("|");

      // v20 — si el cliente eligió una fecha en la agenda interactiva (ISO
      // verificado por backend) y la visita aún no está confirmada, esa
      // fecha manda sobre la que proponga Claude. Hora siempre 09:00.
      const fechaAgendaBackend =
        String(session.agenda_selected_date || "").trim();

      const fechaVisitDayLegacy =
        String(session.visit_day || "").trim();

      const fechaSeleccionadaBackend =
        session.visit_confirmed !== true
          ? (
              /^\d{4}-\d{2}-\d{2}$/.test(fechaAgendaBackend)
                ? fechaAgendaBackend
                : (
                    /^\d{4}-\d{2}-\d{2}$/.test(fechaVisitDayLegacy)
                      ? fechaVisitDayLegacy
                      : null
                  )
            )
          : null;

      const diaFinal =
        fechaSeleccionadaBackend ||
        day?.trim() ||
        session.visit_day ||
        "a coordinar";

      const horaFinal = "09:00";

      // ── v17 — Guarda de idempotencia con fecha/hora definitivas ─────────
      const diaNuevoNorm  = String(diaFinal).trim().toLowerCase();
      const horaNuevaNorm = horaFinal;

      const yaConfirmadaMismoHorario =
        session.visit_confirmed === true &&
        String(session.visit_day || "").trim().toLowerCase() === diaNuevoNorm &&
        String(session.visit_hour || "09:00").trim() === horaNuevaNorm;

      if (yaConfirmadaMismoHorario) {
        console.log(
          `↪️ VISITA ignorada — ya estaba confirmada para ${from} en "${session.visit_day}" ${session.visit_hour}. No se vuelve a tocar el calendario.`
        );

        if (cleanMessage) {
          await sendText(from, cleanMessage);
          addMsg(from, "assistant", cleanMessage);

          if (!esSupervisor) {
            memoria.guardarMensaje({
              phone: fromE164,
              clientName: session.name || null,
              direction: "out",
              type: "text",
              content: cleanMessage,
              session,
            }).catch(() => {});
          }
        }

        return;
      }

      if (
        fechaSeleccionadaBackend &&
        day?.trim() &&
        day.trim() !== fechaSeleccionadaBackend
      ) {
        console.warn(
          `🛡️ VISITA — Claude propuso "${day.trim()}", pero el cliente seleccionó "${fechaSeleccionadaBackend}". Se conserva la fecha verificada por backend.`
        );
      }

      // Todavía NO se marca visit_confirmed=true: solo después de Calendar.
      const updated = update(from, {
        name:            campoLeadValido(name)    || session.name,
        project_desc:    campoLeadValido(project) || session.project_desc,
        zone:            campoLeadValido(zone)    || session.zone,
        visit_day:       diaFinal,
        visit_hour:      horaFinal,
        waze_link:       ubicacion?.trim() || session.waze_link || "",
        client_email:    email?.trim()     || session.client_email || "",
        visit_confirmed: false,
        lead_saved:      session.lead_saved || false,
      });

      const visitHour = updated.visit_hour || "09:00";
      const [hh, mm]  = visitHour.split(":");
      const hourNum   = parseInt(hh);
      const hour12    = hourNum > 12 ? hourNum - 12 : hourNum === 0 ? 12 : hourNum;
      let timeStr     = `${hour12}:${mm} ${hourNum >= 12 ? "p.m." : "a.m."}`;
      let dateStr     = updated.visit_day;

      let eventOk = false;
      let eventData = null;
      try {

        eventData = await createVisitEvent({
          name:    updated.name,
          // v24: clientes de Instagram/Messenger → su WhatsApp de contacto,
          // para que confirmación y recordatorio les lleguen.
          phone:   (esCanalMeta && updated.whatsapp_contacto) ? updated.whatsapp_contacto : from,
          email:   updated.client_email,
          project: updated.project_desc,
          zone:    updated.zone,
          day:     updated.visit_day,
          hour:    updated.visit_hour,
          notes:   updated.waze_link
            ? `Ubicación / Waze: ${updated.waze_link}`
            : "",
        });

        if (eventData.success === true) {
          eventOk = true;

          // SOLO ahora la visita se considera confirmada.
          update(from, {
            visit_confirmed: true,
            lead_saved: true,
            agenda_selected_date: null,
          });

          updated.visit_confirmed = true;
          updated.lead_saved = true;
          updated.agenda_selected_date = null;

          const nombreDetectado = updated.name || campoLeadValido(name);

          if (nombreDetectado) {
            memoria.actualizarNombreInmediato(fromE164, nombreDetectado, {
              proyecto:       updated.project_desc || "",
              zona:           updated.zone || "",
              visitaAgendada: true,
            }).catch(() => {});
          }

          dateStr = eventData.date.toLocaleDateString("es-CR", {
            weekday: "long",
            day: "numeric",
            month: "long",
            timeZone: TZ,
          });

          console.log(
            `📅 Visita agendada: ${eventData.htmlLink || eventData.eventId || "evento creado"}`
          );

        } else {
          console.warn(
            `⛔ Visita NO agendada (flujo cliente): ${eventData.reason || "error_desconocido"} — ${eventData.conflict || "—"}`
          );
        }

      } catch (calErr) {
        console.error("❌ Error Calendar:", calErr.message);
      }

      // v14 — la mini-guía de Claude se envía primero, como mensaje aparte.
      if (cleanMessage) {
        await sendText(from, cleanMessage);
        addMsg(from, "assistant", cleanMessage);
        if (!esSupervisor) {
          memoria.guardarMensaje({ phone: fromE164, clientName: updated.name || session.name || null, direction: "out", type: "text", content: cleanMessage, session }).catch(() => {});
        }
      }

      // El mensaje de RESULTADO se arma SOLO a partir del resultado real.
      let finalClientMessage;

      if (eventOk) {
        try {
          await sendVisitConfirmation({
            name: updated.name, phone: from, project: updated.project_desc,
            zone: updated.zone, day: updated.visit_day, hour: updated.visit_hour,
            wazeLink: updated.waze_link, clientEmail: updated.client_email,
            dateStr, timeStr,
          });
        } catch (emailErr) {
          console.error("❌ Error email:", emailErr.message);
        }

        registerVisit({ ...updated, phone: from }).catch(() => {});
        logLead(from, updated, "visita_solicitada");
        finalClientMessage = `✅ ¡Listo! Su cita quedó agendada para el *${dateStr} a las ${timeStr}*. Le llegará una confirmación por correo 📅`;

        await notifyAllSupervisors(from, updated, "Visita confirmada automáticamente por Sasha.", "visita_solicitada");

      } else {
        const rechazo = eventData
          ? await formatearRechazoDisponibilidad(eventData, updated.visit_day)
          : "⚠️ Hubo un problema técnico al consultar el calendario.";

        finalClientMessage = [
          `Disculpe, ese horario ya no está disponible 🙏`,
          ``,
          rechazo.replace(/^⚠️ No se pudo agendar: /, ""),
          ``,
          `¿Le sirve alguna de esas opciones, o prefiere otro día?`,
        ].join("\n");

        update(from, { visit_confirmed: false, lead_saved: session.lead_saved || false });
        await notifyAllSupervisors(
          from, updated,
          `⚠️ Intento de agendar chocó con un bloqueo/cita existente (${eventData?.reason || "error"}). El cliente sigue esperando horario.`,
          "visita_solicitada"
        );
        logLead(from, updated, "visita_rechazada_conflicto");
      }

      await sendText(from, finalClientMessage);
      addMsg(from, "assistant", finalClientMessage);

      if (!esSupervisor) {
        memoria.guardarMensaje({ phone: fromE164, clientName: updated.name || null, direction: "out", type: "text", content: finalClientMessage, session }).catch(() => {});
      }

      // Monitor supervisores — refleja los DOS mensajes reales del cliente.
      const clientLabel    = updated.name ? `${updated.name} (${from})` : from;
      const clientMsgLabel = imageDataArray.length > 0
        ? `📷 [${imageDataArray.length} foto(s)]${normalized ? ` "${normalized}"` : ""}`
        : normalized;
      const sashaTexto = cleanMessage
        ? `${cleanMessage}\n\n[luego, resultado verificado del calendario:]\n${finalClientMessage}`
        : finalClientMessage;
      const monitorMsg = `👁️ *Conversación en tiempo real*\n👤 Cliente: ${clientLabel}\n\n💬 *Cliente:* ${clientMsgLabel}\n🤖 *Sasha:* ${sashaTexto}`;
      for (const supervisor of SUPERVISORES) {
        sendText(supervisor, monitorMsg).catch(err => {
          console.error(`❌ Monitor [${supervisor}]: ${err.message}`);
        });
      }
      if (mediaIds) {
        const ids = Array.isArray(mediaIds) ? mediaIds : [mediaIds];
        for (const mediaId of ids) {
          for (const supervisor of SUPERVISORES) {
            sendMediaById(supervisor, mediaId, "image", `📷 Foto de cliente: ${clientLabel}`).catch(() => {});
          }
        }
      }

      return; // VISITA ya se manejó por completo.
    }

    // ── Flujo genérico (todo lo que NO es VISITA) ─────────────────────────────
    await sendText(from, cleanMessage);
    addMsg(from, "assistant", cleanMessage);

    if (!esSupervisor) {
      memoria.guardarMensaje({ phone: fromE164, clientName: session.name || null, direction: "out", type: "text", content: cleanMessage, session }).catch(() => {});
    }

    // ── Monitor supervisores ──────────────────────────────────────────────────
    const clientLabel    = session.name ? `${session.name} (${from})` : from;
    const clientMsgLabel = imageDataArray.length > 0
      ? `📷 [${imageDataArray.length} foto(s)]${normalized ? ` "${normalized}"` : ""}`
      : normalized;
    const monitorMsg = `👁️ *Conversación en tiempo real*\n👤 Cliente: ${clientLabel}\n\n💬 *Cliente:* ${clientMsgLabel}\n🤖 *Sasha:* ${cleanMessage}`;
    for (const supervisor of SUPERVISORES) {
      sendText(supervisor, monitorMsg).catch(err => {
        console.error(`❌ Monitor [${supervisor}]: ${err.message}`);
      });
    }
    if (mediaIds) {
      const ids = Array.isArray(mediaIds) ? mediaIds : [mediaIds];
      for (const mediaId of ids) {
        for (const supervisor of SUPERVISORES) {
          sendMediaById(supervisor, mediaId, "image", `📷 Foto de cliente: ${clientLabel}`).catch(() => {});
        }
      }
    }

    // ── Procesar flags (VISITA ya se manejó arriba) ───────────────────────────
    if (flag === "ESCALAR") {
      update(from, { escalated: true });
      await sendText(from, `📞 Le conecto ahora con *${KNOWLEDGE.empresa.encargado}* de nuestro equipo.`);
      await notifyAllSupervisors(from, session, normalized, "escalacion");

    } else if (flag === "LEAD") {
      // ══════════════════════════════════════════════════════════════════
      // v22 — [LEAD:...] acepta campos vacíos y se ACTUALIZA cada vez que
      // aparece un dato nuevo (antes solo se registraba la primera vez).
      // ══════════════════════════════════════════════════════════════════
      const [name, project, zone] = (flagData || "").split("|");

      const previo = {
        name:         session.name || "",
        project_desc: session.project_desc || "",
        zone:         session.zone || "",
      };

      const updated = update(from, {
        name:         campoLeadValido(name)    || session.name,
        project_desc: campoLeadValido(project) || session.project_desc,
        zone:         campoLeadValido(zone)    || session.zone,
      });

      const huboCambio =
        (updated.name || "")         !== previo.name ||
        (updated.project_desc || "") !== previo.project_desc ||
        (updated.zone || "")         !== previo.zone;

      if (huboCambio) {
        console.log(`📋 v22 — LEAD actualizado para ${fromE164}: nombre="${updated.name || "—"}" | proyecto="${updated.project_desc || "—"}" | zona="${updated.zone || "—"}"`);

        if (updated.name) {
          memoria.actualizarNombreInmediato(fromE164, updated.name, {
            proyecto: updated.project_desc || "",
            zona:     updated.zone || "",
          }).catch(() => {});
        }
      }

      if (!session.lead_saved || huboCambio) {
        update(from, { lead_saved: true });
        logLead(from, updated);
        upsertLead({ ...updated, phone: from }).catch(() => {});
      }

    } else if (flag === "SOLICITANTE") {
      update(from, { modo: "solicitante", rrhh_paso: 0, rrhh_data: {} });
      await sendText(from, `Gracias por su interés en trabajar con *SS Remodelaciones* 👷\n\nPara registrar su información en Recursos Humanos, le haré unas preguntas.`);

    } else if (flag === "PROVEEDOR") {
      update(from, { modo: "proveedor", rrhh_paso: 0, rrhh_data: {} });
      await sendText(from, `Gracias por su interés en ser proveedor de *SS Remodelaciones* 🏗️\n\nVoy a registrar los datos de su empresa.`);
    }

  } catch (err) {
    console.error("❌ Error en handleMessage:", err.message, err.stack);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RRHH FLOW
// ═══════════════════════════════════════════════════════════════════════════════
async function handleRRHHFlow(from, normalized, session, tipo) {
  const PASOS  = tipo === "solicitante" ? PASOS_SOLICITANTE : PASOS_PROVEEDOR;
  const paso   = session.rrhh_paso || 0;
  const data   = session.rrhh_data || {};

  if (paso < PASOS.length) {
    const pregunta = PASOS[paso];
    const campo    = pregunta.campo;
    if (paso > 0 && campo) {
      data[campo] = normalized;
      update(from, { rrhh_data: data });
    }
    const nextPaso = paso + 1;
    if (nextPaso <= PASOS.length) {
      update(from, { rrhh_paso: nextPaso });
      if (nextPaso <= PASOS.length) {
        await sendText(from, PASOS[nextPaso - 1].texto);
        return;
      }
    }
  }

  const lastCampo = PASOS[PASOS.length - 1]?.campo;
  if (lastCampo && normalized) {
    data[lastCampo] = normalized;
    update(from, { rrhh_data: data });
  }

  if (tipo === "solicitante") {
    await guardarSolicitante({
      phone: from, nombre: data.nombre, cedula: data.cedula,
      telefono: data.telefono, direccion: data.direccion,
      habilidad: data.habilidad, curriculum: data.curriculum,
    });
    await sendText(from, `✅ *¡Gracias ${data.nombre || ""}!*\n\nSu información quedó registrada en nuestro sistema de Recursos Humanos 📋\n\nCuando tengamos proyectos disponibles, lo contactaremos. ¡Mucho éxito! 🏗️\n\n_Sasha — Bot SS Remodelaciones_`);
    for (const sup of SUPERVISORES) {
      sendText(sup, `👷 *Nuevo solicitante de trabajo*\n\n📱 ${from}\n👤 ${data.nombre||"—"}\n🪪 Cédula: ${data.cedula||"—"}\n📞 ${data.telefono||"—"}\n📍 ${data.direccion||"—"}\n🔧 ${data.habilidad||"—"}\n📋 ${data.curriculum||"—"}\n\n_Sasha — Bot SSR_`).catch(() => {});
    }
  } else {
    await guardarProveedor({
      phone: from, empresa: data.empresa, contacto: data.contacto,
      email: data.email, telefono: data.telefono, sector: data.sector,
    });
    await sendText(from, `✅ ¡Perfecto! Registramos la información de *${data.empresa||"su empresa"}* en nuestra base de proveedores.\n\nCuando tengamos necesidades en su área, los contactaremos. ¡Gracias! 🏗️`);
    for (const sup of SUPERVISORES) {
      sendText(sup, `🏭 *Nuevo proveedor registrado*\n\n📱 ${from}\n🏢 ${data.empresa||"—"}\n👤 ${data.contacto||"—"}\n📧 ${data.email||"—"}\n📞 ${data.telefono||"—"}\n🏗️ ${data.sector||"—"}\n\n_Sasha — Bot SSR_`).catch(() => {});
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
// v11/v12/v13 — Detección de día/fecha: primero fecha específica, luego nombre
// de día, luego hoy/mañana, y por último disponibilidad genérica ("GENERICO").
function detectDayOrDate(text) {
  const n = (text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // 1) Fecha específica primero — es más precisa que un nombre de día.
  const MONTHS = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  for (const mes of MONTHS) {
    const re = new RegExp(`(\\d{1,2})\\s+(?:de\\s+)?${mes}`, "i");
    const m  = n.match(re);
    if (m) return `${m[1]} de ${mes}`;
  }
  const m2 = n.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (m2) return `${m2[1]}/${m2[2]}`;

  // 2) Nombre de día (solo si no hubo fecha específica).
  if (n.includes("lunes"))     return "lunes";
  if (n.includes("martes"))    return "martes";
  if (n.includes("viernes"))   return "viernes";
  if (n.includes("miercoles")) return "miercoles";
  if (n.includes("jueves"))    return "jueves";
  if (n.includes("sabado"))    return "sabado";
  if (n.includes("domingo"))   return "domingo";

  // 3) "hoy"/"mañana" explícitos → día hábil más cercano.
  if (n.includes("hoy")) return nearestBusinessDayName();
  if (n.includes("manana") || n.includes("mañana")) return nearestBusinessDayName();

  // 4) Pregunta de disponibilidad genérica, sin día/fecha puntual.
  if (PALABRAS_DISPONIBILIDAD_GENERICA.some(p => n.includes(p.normalize("NFD").replace(/[\u0300-\u036f]/g, "")))) {
    return "GENERICO";
  }

  return null;
}

// v12 — traduce "hoy"/"mañana" al día hábil de visitas más cercano.
function nearestBusinessDayName() {
  const DIAS = { 1: "lunes", 2: "martes", 5: "viernes" };
  const now  = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  const hoy  = now.getDay();

  if (DIAS[hoy]) return DIAS[hoy];

  for (let i = 1; i <= 7; i++) {
    const d = (hoy + i) % 7;
    if (DIAS[d]) return DIAS[d];
  }
  return "lunes";
}

function parseFlags(response) {
  const flagRegex    = /\[(ESCALAR|LEAD:([^\]]*)|VISITA:([^\]]*)|SOLICITANTE|PROVEEDOR)\]\s*$/;
  const sistemaRegex = /\[SISTEMA:[\s\S]*?\]/g;
  const match = response.match(flagRegex);

  if (!match) return { cleanMessage: response.replace(sistemaRegex, "").trim(), flag: null, flagData: null };

  const cleanMessage = response.replace(flagRegex, "").replace(sistemaRegex, "").trim();
  const fullFlag     = match[1];

  if (fullFlag === "ESCALAR")     return { cleanMessage, flag: "ESCALAR",     flagData: null };
  if (fullFlag === "SOLICITANTE") return { cleanMessage, flag: "SOLICITANTE", flagData: null };
  if (fullFlag === "PROVEEDOR")   return { cleanMessage, flag: "PROVEEDOR",   flagData: null };
  if (fullFlag.startsWith("LEAD:"))   return { cleanMessage, flag: "LEAD",   flagData: fullFlag.slice(5) };
  if (fullFlag.startsWith("VISITA:")) return { cleanMessage, flag: "VISITA", flagData: fullFlag.slice(7) };

  return { cleanMessage, flag: null, flagData: null };
}

async function notifyAllSupervisors(from, session, lastMsg, tipo) {
  const header = {
    visita_solicitada: "🏗️ NUEVA VISITA AGENDADA",
    escalacion:        "🚨 CLIENTE NECESITA ATENCIÓN",
  }[tipo] || "📋 NOTIFICACIÓN SSR Bot";

  const lines = [
    header, "",
    `📱 ${from}`,
    session.name         && `👤 ${session.name}`,
    session.project_desc && `🏗️ ${session.project_desc}`,
    session.zone         && `📍 ${session.zone}`,
    session.visit_day    && `📅 Día: ${session.visit_day}`,
    session.visit_hour   && `🕐 Hora: ${session.visit_hour}`,
    session.waze_link    && `🗺️ Ubicación: ${session.waze_link}`,
    session.client_email && `📧 Email: ${session.client_email}`,
    "", `💬 "${lastMsg}"`, "",
    "_Sasha — Bot SSR_",
  ].filter(Boolean).join("\n");

  const resultados = await Promise.allSettled(SUPERVISORES.map(num => sendText(num, lines)));
  resultados.forEach((r, i) => {
    if (r.status === "fulfilled") console.log(`✅ Supervisor [${SUPERVISORES[i]}] notificado [${tipo}]`);
    else console.error(`❌ Error notificando ${SUPERVISORES[i]}: ${r.reason?.message}`);
  });
}

function logLead(from, session, tipo = "lead") {
  console.log("📋 LEAD:", JSON.stringify({
    tipo, ts: new Date().toISOString(),
    phone: from, name: session.name||"—",
    project: session.project_desc||"—", zone: session.zone||"—",
    visit_day: session.visit_day||"—", visit_hour: session.visit_hour||"—",
    location: session.waze_link||"—", email: session.client_email||"—",
    visit: session.visit_confirmed||false,
  }));
}

module.exports = {
  handleMessage,
  // v19 — control manual de conversación desde el CRM (usado por server.js)
  pausarConversacion,
  reanudarConversacion,
  estaEnPausaManual,
  msRestantesPausa,
};
