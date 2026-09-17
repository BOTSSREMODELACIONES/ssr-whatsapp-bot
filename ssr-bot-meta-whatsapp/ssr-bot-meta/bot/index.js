/**
 * index.js — Orquestador principal de mensajes para Sasha
 * SS Remodelaciones
 *
 * (ver historial completo de versiones v2 a v12 en el archivo original)
 *
 * ── CAMBIOS v13 — CIERRE DE 3 HUECOS DETECTADOS EN INCIDENTE OMAR QUESADA ──────
 * Auditoría sobre capturas reales de WhatsApp (agosto 2026) donde Sasha dio
 * fechas incorrectas repetidamente y confirmó una visita ANTES de que el
 * backend supiera si el horario estaba realmente libre. v9-v12 ya blindaban
 * el cálculo de fechas específicas y nombres de día — pero quedaban 3 huecos:
 *
 * BUG 1 — Preguntas de disponibilidad SIN mencionar día/fecha ("¿Cuándo se
 *   pueden llegar?", "¿tienen espacio?") no disparaban NINGÚN [SISTEMA:...].
 *   detectDayOrDate() solo reconocía nombres de día, fechas específicas y
 *   "hoy"/"mañana" — una pregunta genérica de disponibilidad caía fuera de
 *   los tres casos y dejaba a Claude respondiendo fechas de memoria, sin
 *   ningún dato verificado. Así se originó el primer error de la
 *   conversación (ofreció "viernes 29 de agosto", que en realidad es
 *   sábado). FIX: nuevo caso "GENERICO" en detectDayOrDate() + manejo
 *   dedicado en handleMessage que inyecta los próximos días hábiles reales
 *   (ya calculados) sin que Claude tenga que inferir nada.
 *
 * BUG 2 — El gate `dayMentioned !== session.slots_shown` bloqueaba la
 *   re-verificación PARA SIEMPRE dentro de una misma conversación: una vez
 *   mostrado "viernes" (o cualquier fecha) una sola vez, ningún mensaje
 *   posterior que volviera a mencionar exactamente ese mismo valor
 *   disparaba una nueva consulta al calendario — ni siquiera si el intento
 *   anterior había fallado. Esto dejó a Sasha respondiendo sin datos reales
 *   en varios puntos de la conversación con Omar, incluyendo una regla de
 *   "un día de anticipación" que NO existe en ningún mensaje de sistema —
 *   Claude la inventó porque no tenía contexto verificado para responder.
 *   FIX: se eliminó el gate de bloqueo; ahora se verifica SIEMPRE que el
 *   cliente mencione un día/fecha/disponibilidad genérica, sin excepción.
 *   slots_shown se sigue guardando, pero solo como referencia/telemetría.
 *
 * BUG 3 (el más grave) — El texto de Claude (cleanMessage) se enviaba al
 *   cliente de inmediato, ANTES de llamar a createVisitEvent(). Cuando
 *   Claude emite el flag [VISITA:...], también escribe una confirmación
 *   ("¡Todo listo!") que salía primero pasara lo que pasara después — y
 *   solo si el backend rechazaba la cita (slot_ocupado, como pasó 3 veces
 *   con Omar porque el horario ya tenía un bloqueo de administrador)
 *   llegaba una segunda corrección. El cliente ya había leído "Todo listo".
 *   FIX (v13): para el flag VISITA, cleanMessage se descarta por completo.
 *   El mensaje real al cliente se construye DESPUÉS de conocer el
 *   resultado real de createVisitEvent(). También se ajustó
 *   notifyAllSupervisors(): en éxito ya no muestra el último mensaje crudo
 *   del cliente (ej. su correo) como "nota" — muestra una nota real
 *   ("Visita confirmada automáticamente").
 *
 * ── CAMBIOS v14 — RECUPERAR LA MINI-GUÍA DE PREPARACIÓN SIN REINTRODUCIR
 *    LA CONFIRMACIÓN FALSA ──────────────────────────────────────────────────
 * v13 descartaba cleanMessage por completo para el flag VISITA — pero ese
 *   texto también trae la mini-guía de preparación (ONBOARDING
 *   POST-AGENDAMIENTO en claude.js: "tenga acceso al área", "traiga fotos",
 *   etc.), que es información legítima y útil que el cliente dejó de
 *   recibir. FIX de dos capas:
 *   1) claude.js: nueva sección de system prompt que le prohíbe
 *      explícitamente a Claude afirmar éxito ("Todo listo", "quedó
 *      agendada") en el mensaje que acompaña al flag [VISITA:...].
 *   2) index.js: cleanMessage ahora SÍ se envía — como mensaje aparte,
 *      ANTES de intentar la reserva — y el resultado real (éxito o
 *      rechazo) llega en un SEGUNDO mensaje independiente, construido
 *      exclusivamente a partir de lo que devuelve createVisitEvent().
 *   El broadcast al monitor de supervisores refleja ambos mensajes, en el
 *   mismo orden en que los recibió el cliente.
 * También se movió la verificación de "¿en qué día cae esta fecha?" para
 *   que sea EXCLUSIVAMENTE responsabilidad del backend: claude.js ya no le
 *   pide a Claude que verifique él mismo si una fecha específica cae en
 *   día hábil — eso ahora está señalado como prohibido en el prompt,
 *   coherente con los [SISTEMA:...] deterministas de index.js/calendar.js.
 *
 * ── CAMBIOS v15 (2 sept 2026) — MÓDULO DE CONSULTAS FINANCIERAS ───────────────
 * BUG REAL: "resumen de los pagos realizados por un cliente? Jose Flores"
 *   fue tratado como un comando de REGISTRO en vez de una consulta. Causa:
 *   esComandoFinanciero() en finanzas.js clasifica por substring, y "pago"
 *   (una de las KEYWORDS_FINANZAS) es substring literal de "pagos". Como el
 *   mensaje no traía ningún dígito, cayó en esComandoFinancieroSinMonto() →
 *   Sasha respondió "Anotado, mandame la foto..." en vez de responder.
 * FIX: nuevo módulo consultas.js, dedicado EXCLUSIVAMENTE a preguntas de
 *   solo lectura (resumen de pagos/gastos por cliente o proyecto). Se
 *   evalúa en un PASO 0.5, ANTES que finanzas.js, para que ninguna consulta
 *   pueda malinterpretarse como un registro. Usa un endpoint de lectura
 *   nuevo en Apps Script (accion=consulta_movimientos) que nunca escribe.
 *
 * ── CAMBIOS v17 (11 sept 2026) — FIX CRÍTICO: "GRACIAS" RE-DISPARABA UNA
 *    SEGUNDA VISITA SOBRE UNA CITA YA CONFIRMADA ────────────────────────────
 * BUG REAL (reportado por Darwin con capturas de WhatsApp): a Shirley
 *   Vargas se le confirmó exitosamente el viernes 18 de septiembre a las
 *   9:00 a.m. ("✅ ¡Listo! Su cita quedó agendada..."). La clienta respondió
 *   simplemente "Gracias" — y ese mensaje, sin mencionar ningún día ni
 *   pedir cambios, disparó una SEGUNDA emisión del flag [VISITA:...] con el
 *   MISMO día y hora ya confirmados, lo que volvió a invocar
 *   createVisitEvent() para una cita que YA EXISTÍA. El evento chocó contra
 *   sí mismo (mitigado aparte en calendar.js v16, que ahora reconoce citas
 *   propias del mismo cliente y no las trata como conflicto), pero la causa
 *   de fondo — intentar crear de nuevo algo que ya existe — vivía acá.
 *
 * CAUSA RAÍZ: nada en el código impedía que el flag VISITA se procesara de
 *   nuevo si Claude lo reemitía — y nada en claude.js le decía
 *   explícitamente a Claude que un simple agradecimiento después de una
 *   cita ya confirmada NO amerita un nuevo flag. Ambas capas fallaron a la
 *   vez: el prompt (ver fix correspondiente en claude.js) y el código, que
 *   confiaba ciegamente en que Claude nunca reemitiría el flag de más.
 *
 * FIX: guarda de idempotencia ANTES de tocar el calendario. Si
 *   session.visit_confirmed ya es true y el nuevo flag [VISITA:...] trae el
 *   MISMO día y la MISMA hora que ya están confirmados para este cliente,
 *   se ignora por completo — nunca se vuelve a llamar createVisitEvent().
 *   Si el cliente de verdad quiere cambiar la cita, el nuevo día u hora
 *   serán distintos a los guardados y el flujo normal de reagendamiento
 *   sigue funcionando exactamente igual que antes.
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
} = require("./messenger");

const {
  createVisitEvent,
  getAvailableSlots,
  getAvailableVisitDates,
  verificarDisponibilidadExacta,
  cancelEventByNameAndDate,
  rescheduleEventByNameAndDate,
  listUpcomingEvents,
  proximosDiasHabiles,
} = require("./calendar");

const { sendVisitConfirmation }      = require("./email");
const { upsertLead, registerVisit }  = require("./crm");
const KNOWLEDGE                      = require("./knowledge");
const memoria                        = require("./memoria");
const { procesarComandoFinanciero, esComandoFinanciero, procesarComprobanteImagen } = require("./finanzas");
const { esConsultaFinanciera, procesarConsultaFinanciera } = require("./consultas");
const { guardarSolicitante, guardarProveedor, PASOS_SOLICITANTE, PASOS_PROVEEDOR } = require("./rrhh");
const { manejarRespuestaConfirmacion } = require("./confirmaciones");

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
// PEDIDO POR DARWIN: desde el CRM, poder "tomar el control" de la
// conversación con un cliente puntual — mientras dure eso, Sasha se calla
// para ESE cliente (pero sigue respondiendo normal a cualquier otro). Se
// reactiva sola a los 60 minutos de inactividad de Darwin con ese cliente;
// cada vez que Darwin le escribe de nuevo (vía /send-message en server.js),
// la ventana de 60 minutos se reinicia — así que mientras Darwin siga
// conversando activo, Sasha se mantiene pausada, y en cuanto Darwin deja de
// escribirle por 60 min seguidos, Sasha retoma sola.
//
// DISEÑO: Map en memoria (telefono → timestamp de expiración). server.js
// corre en el MISMO proceso que este archivo (lo importa con
// require("./bot/index")), así que no hace falta Sheets ni Redis para esto
// — un Map alcanza y no le agrega latencia a cada mensaje.
//
// LIMITACIÓN HONESTA: al ser en memoria, un redeploy de Railway (que pasa
// seguido en este proyecto) borra las pausas activas — Sasha volvería a
// responder antes de los 60 minutos si eso ocurre a mitad de una
// intervención manual. Si en la práctica esto molesta, se puede mover a una
// pestaña nueva de Sheets (CONTROL_MANUAL) más adelante; se deja así por
// ahora porque es mucho más simple y cubre el caso normal de uso.
// ══════════════════════════════════════════════════════════════════════════

const PAUSA_MANUAL_MS = 60 * 60 * 1000; // 60 minutos
const pausasManuales  = new Map();       // "+506...": timestamp ms de expiración

function _normE164(phone) {
  const p = String(phone || "").trim();
  return p.startsWith("+") ? p : `+${p}`;
}

// Llamada cuando Darwin toca "Tomar control" en el CRM, o cada vez que le
// manda un mensaje manual a ese cliente (server.js hace ambas cosas).
function pausarConversacion(phone) {
  const fromE164 = _normE164(phone);
  const expira   = Date.now() + PAUSA_MANUAL_MS;
  pausasManuales.set(fromE164, expira);
  console.log(`⏸️ ASISTENCIA MANUAL — pausa activada/renovada para ${fromE164} (expira ${new Date(expira).toLocaleTimeString("es-CR", { timeZone: "America/Costa_Rica" })})`);
  return expira;
}

// Llamada cuando Darwin toca "Devolver a Sasha" en el CRM (liberación manual
// inmediata, sin esperar los 60 minutos).
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

// Para que el CRM pueda mostrar "activo hasta las X:XX" sin adivinar.
function msRestantesPausa(phone) {
  const fromE164 = _normE164(phone);
  const expira   = pausasManuales.get(fromE164);
  if (!expira) return 0;
  return Math.max(0, expira - Date.now());
}

// ══════════════════════════════════════════════════════════════════════════
// v18 (15 sept 2026) — FUSIÓN FOTO+TEXTO EN UN SOLO REGISTRO FINANCIERO
//
// BUG REAL (Darwin): mandó la foto de un comprobante SINPE (₡150.000,
// "Pago alquiler Taller septiembre") y, aparte, un mensaje de texto
// explicando "Registra a nombre de SSR el pago de alquiler..., esto es
// un gasto operativo de SSR, no se asigna a ningún proyecto". Como
// llegaron como DOS mensajes de WhatsApp separados, el sistema los trató
// como DOS intentos de registro totalmente independientes:
//   1) la foto sola (sin el texto, que aún no existía) → Claude solo
//      tuvo el "Detalle" del banco para trabajar, "Taller" chocó contra
//      un proyecto no relacionado, y el intento se rechazó.
//   2) el texto solo, con su propio monto → se procesó de inmediato como
//      comando financiero completo, sin esperar ni combinarse con la
//      foto, y ESE fue el que terminó escribiendo en la hoja.
// Si ambos hubieran tenido éxito, el gasto habría quedado DUPLICADO.
//
// El mecanismo pendingReceiptContext de arriba (v8) ya resolvía la mitad
// de este problema — pero solo cuando el TEXTO llega primero y SIN
// monto (deja dicho "mandame la foto para completar"). No cubría el
// caso de Darwin: la FOTO llega primero, sin texto, y el texto que la
// completa trae su propio monto y por eso se procesaba solo.
//
// FIX: mecanismo simétrico para fotos sin texto. Cuando llega una foto
// de comprobante sin ningún texto que la acompañe (ni caption, ni
// contexto pendiente), en vez de procesarla de inmediato se guarda unos
// segundos dándole chance a que llegue el mensaje de texto aclaratorio
// que Darwin suele mandar aparte. Si ese texto llega mientras la foto
// espera —tenga o no monto propio—, se fusionan en UN solo registro
// (la foto se interpreta con el texto como contexto adicional, igual
// que ya hacía procesarComprobanteImagen). Si no llega nada, la foto se
// procesa sola exactamente como antes.
// ══════════════════════════════════════════════════════════════════════════

// Map<supervisorPhoneE164, Array<{ imgData, ts }>> — cola de fotos de
// comprobante recibidas sin texto que las acompañe todavía, en espera
// de que llegue un mensaje de texto que las complete.
const pendingPhotosByPhone = new Map();

const PENDING_PHOTO_WAIT_MS = 5000;          // margen para que llegue el texto aclaratorio
const PENDING_PHOTO_TTL_MS  = 3 * 60 * 1000; // igual que el contexto de texto (v8)

// Encola una foto pendiente y devuelve la entrada (se usa como "ticket"
// para saber después, tras la espera, si alguien más ya la reclamó).
function agregarFotoPendiente(phoneE164, imgData) {
  const lista = pendingPhotosByPhone.get(phoneE164) || [];
  const entry = { imgData, ts: Date.now() };
  lista.push(entry);
  pendingPhotosByPhone.set(phoneE164, lista);
  return entry;
}

// Quita una entrada puntual de la cola (si sigue ahí). Devuelve true si
// todavía estaba pendiente (nadie la había reclamado), false si ya no
// está (un mensaje de texto la tomó primero, o expiró).
function quitarFotoPendiente(phoneE164, entry) {
  const lista = pendingPhotosByPhone.get(phoneE164);
  if (!lista) return false;
  const idx = lista.indexOf(entry);
  if (idx === -1) return false;
  lista.splice(idx, 1);
  if (lista.length === 0) pendingPhotosByPhone.delete(phoneE164);
  return true;
}

// Toma (y remueve) la foto pendiente más antigua para este número, si
// hay alguna vigente — se usa cuando llega un mensaje de texto que
// podría completarla.
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

// ¿El texto es un comando financiero pero SIN monto detectable? (típico:
// "registra este gasto para el proyecto de X" seguido de una foto).
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
    "+50670068477": "Oficina SSR",
  };
  return map[phone] || phone;
}

// Formatea un número a colones con punto como separador de miles (₡10.000),
// independientemente del locale del servidor (Railway usa espacio con es-CR).
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
// usando JavaScript (confiable), en vez de dejar que Claude lo calcule "de
// memoria" en la conversación (punto ciego conocido de los LLM — así fue
// como se ofreció "viernes 8 de agosto" siendo en realidad sábado).
// Solo aplica a fechas específicas tipo "8 de agosto" o "8/8" — los nombres
// de día (lunes/martes/viernes) ya son inequívocos y no necesitan esto.
// ═══════════════════════════════════════════════════════════════════════════════
const DIAS_SEMANA_ES = ["domingo","lunes","martes","miercoles","jueves","viernes","sabado"];
const MESES_ES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto",
                   "septiembre","octubre","noviembre","diciembre"];
const DIAS_HABILES = ["lunes","martes","viernes"];
const NOMBRES_DIA_NO_HABIL = ["miercoles","jueves","sabado","domingo"];

// v13 — frases que indican que el cliente pregunta por disponibilidad en
// general, SIN mencionar un día o fecha puntual. Antes esto no disparaba
// ningún [SISTEMA:...] y Sasha respondía fechas inventadas de memoria.
const PALABRAS_DISPONIBILIDAD_GENERICA = [
  "cuando se puede", "cuando pueden", "cuando podrian", "cuando podrían",
  "que dia", "que día", "que dias", "qué días", "cuales dias", "cuáles días",
  "disponibilidad", "tienen espacio", "hay espacio", "cuando llegan",
  "cuando vienen", "pueden llegar", "pueden venir", "cuando hay",
  "que horarios", "qué horarios", "cuando tienen", "cuándo tienen",
  "cuando es la visita", "cuando seria", "cuando sería",
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
      // v11: mismo criterio que calendar.js — si ya pasó, es el próximo año,
      // no una fecha arbitraria cercana.
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

// v11 — Formatea una lista de fechas (Date[]) como "viernes 7 de agosto,
// lunes 10 de agosto, martes 11 de agosto" para inyectar en el contexto de
// Claude. Siempre fechas YA calculadas — nunca le pedimos a Claude que
// calcule cuál es "el próximo viernes" o similar.
function formatearListaFechas(fechas) {
  return fechas.map(d => {
    const nombreDia    = d.toLocaleDateString("es-CR", { timeZone: TZ, weekday: "long" });
    const fechaLegible = d.toLocaleDateString("es-CR", { timeZone: TZ, day: "numeric", month: "long" });
    return `${nombreDia} ${fechaLegible}`;
  }).join(", ");
}

// ═══════════════════════════════════════════════════════════════════════════════
// v20 — AGENDA INTERACTIVA CON DISPONIBILIDAD REAL DE GOOGLE CALENDAR
//
// IMPORTANTE:
// - Google Calendar es la única fuente de verdad.
// - Nunca presentamos como "disponible" un simple lunes/martes/viernes.
// - getAvailableVisitDates() devuelve únicamente fechas cuyo slot real de
//   visita (09:00–10:00) está libre.
// - Los IDs agenda_* son determinísticos y server.js ya los entrega a
//   handleMessage() como texto cuando el cliente toca una opción.
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


// Consulta SIEMPRE Google Calendar.
// No reutiliza una lista vieja guardada en la sesión.
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


// Muestra al cliente hasta 10 fechas REALES mediante una lista interactiva
// de WhatsApp. Cada fila devuelve un ID tipo:
//
// agenda_fecha_2026-09-21
//
// server.js ya convierte ese ID en texto y lo manda a handleMessage().
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
// Ejemplo:
//
// agenda_fecha_2026-09-21
//
// Devuelve "2026-09-21" o null.
function extraerFechaAgendaInteractiva(texto) {
  const match = String(texto || "")
    .trim()
    .match(/^agenda_fecha_(\d{4}-\d{2}-\d{2})$/);

  return match ? match[1] : null;
}


// Verifica que una fecha seleccionada siga apareciendo como disponible
// AHORA MISMO.
//
// Esto NO sustituye la validación final de createVisitEvent().
// Es una primera defensa contra listas que quedaron viejas mientras el
// cliente decidía. createVisitEvent() volverá a validar justo antes de
// insertar el evento.

async function fechaSigueDisponibleAgenda(fechaISO) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fechaISO || ""))) {
    return false;
  }

  try {
    const [year, month, day] = fechaISO.split("-").map(Number);

    // La visita de clientes siempre es a las 09:00.
    // Construimos la fecha directamente en hora local de Costa Rica.
    const startDate = new Date(
      year,
      month - 1,
      day,
      9,
      0,
      0,
      0
    );

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
// HELPER v9 — Formatear rechazo de disponibilidad (bloqueo/slot ocupado) y
// sugerir horarios alternativos del mismo día para no dejar al supervisor
// (ni al flujo automático) sin salida.
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

  // Si el día solicitado todavía puede tener disponibilidad,
  // consultamos Calendar directamente.
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

    // Calendar.js devuelve success/reason/conflict/date.
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
// NUEVO v7 — GESTIÓN DE CALENDARIO PARA SUPERVISORES
// Cancelar, reagendar y consultar citas por lenguaje natural (texto o audio).
// ═══════════════════════════════════════════════════════════════════════════════

// Detección rápida por palabras clave: ¿este mensaje habla del calendario?
// Solo si pasa este filtro se llama a Claude para interpretar (ahorra API).
function mencionaCalendario(texto) {
  const n = (texto || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const hablaDeCitas   = /\b(cita|citas|visita|visitas|evento|eventos|reunion|reuniones|agenda|calendario)\b/.test(n);
  const tieneAccion    = /\b(cancel|borr|elimin|quit|cambi|mov[ea]|move|pas[aá]|reagend|reprogram|corr[ea]|adelant|atras|que|cual|cuales|hay|tengo|tenemos|mostr|dame|decime|dime|lista|ver)\w*\b/.test(n);
  return hablaDeCitas && tieneAccion;
}

// Interpretar el comando con Claude → JSON estructurado.
// Devuelve: { accion: "cancelar"|"reagendar"|"consultar"|"ninguna",
//             nombre, fecha, nuevaFecha, nuevaHora, avisarCliente }
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

// Fallback sin API: regex simple (el detector viejo, mejorado). Solo cancelar.
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

      // Notificar a los clientes afectados
      let notificados = 0;
      if (intent.avisarCliente !== false) {
        for (const ev of result.events) {
          if (ev.clientPhone && !SUPERVISORES.includes(ev.clientPhone)) {
            const msg = `Hola, le escribimos de *SS Remodelaciones* 🏗️\n\nLe informamos que su visita técnica del *${ev.dateStr}* fue cancelada.\n\nSi desea reprogramarla, con gusto le atendemos por este medio. ¡Disculpe las molestias! 🙏`;
            sendText(ev.clientPhone, msg).catch(() => {});
            notificados++;
          }
        }
      }

      const lineas = result.events.map(e => `• ${e.summary} — ${e.dateStr}`).join("\n");
      const plural = result.deleted > 1;
      return [
        `✅ *${plural ? `${result.deleted} citas canceladas` : "Cita cancelada"}*:`,
        ``,
        lineas,
        ``,
        intent.avisarCliente === false
          ? `🔕 Cliente NO notificado (como pediste).`
          : notificados > 0
            ? `✉️ Cliente notificado automáticamente por WhatsApp.`
            : `ℹ️ No se pudo notificar al cliente (sin teléfono en el evento).`,
        `👤 Por: ${quien}`,
      ].join("\n");
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

      if (result.ambiguous) {
        const lineas = result.events.map(e => `• ${e.summary} — ${e.dateStr}`).join("\n");
        return `⚠️ Encontré *${result.events.length} citas* que coinciden. Especificá mejor (nombre completo o fecha):\n\n${lineas}`;
      }

      if (result.error === "fecha_pasada") {
        return `⚠️ La nueva fecha ya pasó. Indicá una fecha futura.`;
      }

      // ── v9: destino ocupado/bloqueado — antes caía en el "no encontré la
      // cita" genérico, lo cual era engañoso (la cita SÍ existe, el problema
      // es el destino). Ahora se informa el motivo real y se sugieren
      // horarios alternativos del día de destino.
      if (result.error === "destino_ocupado") {
        const motivoTexto = {
          dia_bloqueado:    "ese día está bloqueado internamente",
          slot_ocupado:     "ese horario ya está ocupado",
          dia_no_laborable: "esa fecha no cae en día de visitas (solo lunes, martes o viernes)",
        }[result.motivo] || "ese horario no está disponible";

        // v11: si el motivo es día no hábil, ofrecemos fechas reales ya
        // calculadas en vez de intentar sacar slots de un día imposible.
        let sugerencia = "";
        if (result.motivo === "dia_no_laborable") {
          const proximos = proximosDiasHabiles(new Date(new Date().toLocaleString("en-US", { timeZone: TZ })), 3);
          sugerencia = `\n\n📅 Próximas fechas disponibles: ${formatearListaFechas(proximos)}`;
        } else if (intent.nuevaFecha) {
          try {
            // v12: getAvailableSlots ahora devuelve { date, dateLabel, slots }.
            const resultado = await getAvailableSlots(intent.nuevaFecha);
            const slots = resultado.slots;
            if (slots.length > 0) {
              const slotsText = slots.map(s => {
                const [h, m] = s.split(":");
                const hNum   = parseInt(h);
                const h12    = hNum > 12 ? hNum - 12 : hNum;
                return `${h12}:${m} ${hNum >= 12 ? "p.m." : "a.m."}`;
              }).join(", ");
              sugerencia = `\n\n🕐 Horarios libres ${resultado.dateLabel ? `el ${resultado.dateLabel}` : "ese día"}: ${slotsText}`;
            }
          } catch {}
        }

        return `⚠️ No se pudo reagendar: ${motivoTexto}${result.conflicto ? ` (${result.conflicto})` : ""}.${sugerencia}`;
      }

      if (result.moved === 0) {
        const q = intent.nombre ? ` de *${intent.nombre}*` : "";
        return `📭 No encontré la cita${q} para mover.\n\nVerificá el nombre o la fecha.`;
      }

      const ev = result.events[0];

      // Notificar al cliente del cambio
      let clienteNotificado = false;
      if (intent.avisarCliente !== false && ev.clientPhone && !SUPERVISORES.includes(ev.clientPhone)) {
        const msg = `Hola, le escribimos de *SS Remodelaciones* 🏗️\n\nSu visita técnica fue *reprogramada*:\n\n❌ Antes: ${ev.oldDateStr}\n✅ Ahora: *${ev.newDateStr}*\n\nSi tiene alguna consulta, con gusto le atendemos. ¡Hasta pronto! 😊`;
        sendText(ev.clientPhone, msg).catch(() => {});
        clienteNotificado = true;
      }

      return [
        `✅ *Cita reagendada*`,
        ``,
        `📋 ${ev.summary}`,
        `❌ Antes: ${ev.oldDateStr}`,
        `✅ Ahora: *${ev.newDateStr}*`,
        ``,
        intent.avisarCliente === false
          ? `🔕 Cliente NO notificado (como pediste).`
          : clienteNotificado
            ? `✉️ Cliente notificado automáticamente por WhatsApp.`
            : `ℹ️ No se pudo notificar al cliente (sin teléfono en el evento).`,
        `👤 Por: ${quien}`,
      ].join("\n");
    } catch (err) {
      console.error("❌ Error reagendando cita:", err.message);
      return `❌ Error al reagendar la cita: ${err.message}`;
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════
async function handleMessage(from, text, messageId, mediaIds = null) {
  if (messageId) markRead(messageId).catch(() => {});

  const normalized = (text || "").trim();
  const session    = get(from);
  const fromE164   = from.startsWith("+") ? from : `+${from}`;

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
  // v18 (16 sept 2026) — CONFIRMACIÓN DE VISITA (botones Sí/No)
  //
  // Cuando un cliente toca uno de los botones del recordatorio de las 7pm
  // (ver confirmaciones.js), WhatsApp devuelve el ID de ese botón como si
  // fuera el texto del mensaje (ver server.js, msg.interactive.button_reply.id
  // → addToBuffer). Se revisa ACÁ, antes de cualquier otro procesamiento
  // (asistencia, financiero, flujo comercial), porque no es ninguna de esas
  // cosas — es la respuesta a una pregunta puntual que ya sabemos qué
  // significa por el propio ID. Si manejarRespuestaConfirmacion() reconoce
  // el patrón, se encarga de todo (mensaje al cliente + aviso a Darwin y
  // Melvin) y no hay que seguir procesando este mensaje de ninguna otra
  // forma.
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

if (!esSupervisor) {

  const telefonoAsistencia = String(from || "")
    .replace(/\D/g, "");

  try {

    // ==========================================================
    // 1. VERIFICAR SI EL NÚMERO ES DE UN TRABAJADOR SSR
    // ==========================================================

    const verificacion =
      await esTrabajadorSSR(telefonoAsistencia);


    // ==========================================================
    // 2. SI HUBO ERROR CONSULTANDO APPS SCRIPT
    // NO LO TRATAMOS COMO CLIENTE
    // ==========================================================

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

      // MUY IMPORTANTE:
      // detenemos aquí para impedir que el trabajador
      // caiga al flujo comercial de Sasha.
      return;
    }


    // ==========================================================
    // 3. SI ES TRABAJADOR
    // ==========================================================

    if (
      verificacion &&
      verificacion.esTrabajador === true
    ) {

      console.log(
        `👷 SASHA ASISTENCIA — trabajador reconocido: ${telefonoAsistencia}`
      );

// ========================================================
// FOTO DE ASISTENCIA
// Conservamos el mediaId original para poder reenviar
// la fotografía a Darwin, pero además descargamos la
// imagen en Base64 para que Claude pueda analizarla.
// ========================================================

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


      // ========================================================
      // 4. PROCESAR ASISTENCIA
      // ========================================================

      const resultadoAsistencia =
  await procesarAsistencia({
    telefono: telefonoAsistencia,
    texto: normalized,

    // ID original de WhatsApp.
    // Se conserva para registrar/reenviar la foto.
    foto: fotoAsistencia,

    // Imagen real descargada.
    // Claude recibe Base64 + MIME para validar el gesto.
    imagen: imagenAsistencia,

    messageId: messageId || "",

    // v4 — reutilizar el estado que esTrabajadorSSR() ya consultó
    // hace un instante, para no volver a preguntarle lo mismo a
    // Apps Script (ver nota extensa en asistencia.js).
    estadoPrevio: verificacion.estado || null
  });


      console.log(
        "👷 SASHA ASISTENCIA — resultado:",
        JSON.stringify(resultadoAsistencia)
      );


      // ========================================================
      // 5. RESPUESTA AL TRABAJADOR
      // ========================================================

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


        // ======================================================
        // 6. NOTIFICACIÓN A DARWIN
        // SOLO MOVIMIENTOS REALMENTE CONFIRMADOS
        // ======================================================

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


          // ====================================================
          // ENTRADA
          // ====================================================

          if (
            tipoAsistencia === "entrada_registrada"
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


          // ====================================================
          // PROYECTO ASIGNADO
          // ====================================================

          if (
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

          // ====================================================
          // SALIDA — REPORTE COMPLETO A DARWIN
          // ====================================================

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

    // 1. Enviar resumen de asistencia
    await sendText(
      DARWIN_PHONE,
      mensajeDarwin
    );

    // 2. Reenviar a Darwin la fotografía REAL
    // recibida del trabajador
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
              
        // ======================================================
        // TRABAJADOR: SIEMPRE TERMINA AQUÍ
        // NUNCA PASA AL FLUJO COMERCIAL
        // ======================================================

        return;
      }


      console.warn(
        `⚠️ Trabajador reconocido pero Asistencia no devolvió resultado: ${telefonoAsistencia}`
      );

      return;
    }


    // ==========================================================
    // 7. NO ES TRABAJADOR
    // ==========================================================

    console.log(
      `👤 SASHA — ${telefonoAsistencia} no es trabajador SSR; continúa flujo comercial.`
    );

    // NO hacemos return.
    // Continúa normalmente al resto de index.js.


  } catch (err) {

    // ==========================================================
    // 8. FAIL CLOSED
    //
    // Si el módulo de asistencia falla inesperadamente,
    // NO mandamos a esa persona al flujo comercial.
    // ==========================================================

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
        
  // ── v4/v8/v18: lectura de comprobantes bancarios por imagen ──────────────────
  // v8: se fusiona con cualquier contexto de texto pendiente de ESTE supervisor
  // (ej. "regístrame esto a nombre del proyecto de Christian" mandado como
  // mensaje aparte, segundos antes de la foto).
  // v18: si la foto llega SIN texto que la acompañe (ni caption, ni contexto
  // previo), no se procesa de inmediato — se deja pendiente unos segundos por
  // si llega un mensaje de texto aclaratorio aparte (ver nota extensa junto a
  // pendingPhotosByPhone, arriba). Si ese texto llega, PASO 1 más abajo la
  // reclama y la fusiona en un solo registro; si no llega nada, se procesa
  // sola exactamente como antes.
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
            // Un mensaje de texto ya la reclamó y la procesó combinada
            // mientras esperábamos — no hacer nada más con esta foto.
            continue;
          }

          // Nadie la reclamó en la ventana de espera. Revisamos una vez
          // más por si quedó contexto de texto pendiente mientras
          // esperábamos, y seguimos con la foto sola.
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

    // ── FIX v3: desenvolver instrucción de voz ANTES de evaluar comandos.
    // v7: ahora se usa TAMBIÉN para calendario (antes solo finanzas), porque
    // el envoltorio [Instrucción de voz...] rompía la detección de citas
    // cuando el comando llegaba por audio.
    const textoLimpio = desenvolverInstruccionVoz(normalized);

    // ── PASO 0.5 (v15): Consultas financieras de solo lectura ─────────────────
    // Va ANTES de finanzas.js a propósito. esComandoFinanciero() clasifica por
    // substring y "pago" matchea dentro de "pagos" — sin este paso, una
    // pregunta como "resumen de los pagos de Jose Flores" caía en el flujo de
    // REGISTRO (finanzas.js) en vez de responderse. esConsultaFinanciera()
    // detecta frases de consulta (resumen, cuánto, listado, etc.) y responde
    // desde consultas.js, que solo LEE — nunca llega a finanzas.js.
    if (esConsultaFinanciera(textoLimpio)) {
      const respuestaConsulta = await procesarConsultaFinanciera(textoLimpio);
      await sendText(from, respuestaConsulta);
      return;
    }

    // ── PASO 1 (v6/v18): Finanzas en lenguaje natural → DIRECTO a finanzas.js ─
    const cmd = normalized;

    if (!/^\[(GASTO|INGRESO):/i.test(cmd) && esComandoFinanciero(textoLimpio)) {

      // v18 — si hay una foto de comprobante esperando (mandada segundos
      // antes, sin texto todavía), la fusionamos con ESTE texto en un solo
      // registro, tenga o no monto propio el texto. Esto es lo que evita
      // el bug real: una foto y un texto mandados por separado para el
      // MISMO gasto ya no se procesan como dos intentos independientes
      // (con riesgo de registrar el mismo gasto dos veces).
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

      // v8 — si el comando NO trae ningún monto, lo más probable es que el
      // supervisor va a mandar la foto del comprobante a continuación. En
      // vez de generar un "Monto inválido" falso, lo guardamos como
      // contexto pendiente y esperamos la imagen.
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
    // Usa el texto DESENVUELTO → funciona igual por texto o por audio.
    const respCalendario = await gestionarCalendarioSupervisor(textoLimpio, fromE164);
    if (respCalendario !== null) {
      await sendText(from, respCalendario);
      return;
    }

    // ── PASO 3: Comandos estructurados de supervisor ──────────────────────────

    // [GASTO: monto | descripcion]
    if (/^\[GASTO:/i.test(cmd)) {
      const respuesta = await handleGasto(cmd, fromE164);
      await sendText(from, respuesta);
      await copiaFinancieraADarwin(fromE164, respuesta);
      return;
    }

    // [INGRESO: monto | descripcion]
    if (/^\[INGRESO:/i.test(cmd)) {
      const respuesta = await handleIngreso(cmd, fromE164);
      await sendText(from, respuesta);
      await copiaFinancieraADarwin(fromE164, respuesta);
      return;
    }

    // [MSG_CLIENTE: nombre_o_telefono | mensaje]
    if (/^\[MSG_CLIENTE:/i.test(cmd)) {
      const respuesta = await handleMsgCliente(cmd, fromE164);
      await sendText(from, respuesta);
      return;
    }

    // [VISITA: tel_cliente | nombre | proyecto | zona | dia | hora | ubicacion | email]
    if (/^\[VISITA:/i.test(cmd)) {
      const respuesta = await handleVisitaSupervisor(cmd, fromE164);
      await sendText(from, respuesta);
      return;
    }

    // [RESUMEN_CLIENTE: nombre] — acceso directo al resumen IA
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
        .filter(Boolean);    }

    const imageData = imageDataArray.length === 0 ? null
      : imageDataArray.length === 1 ? imageDataArray[0]
      : imageDataArray;

    if (!normalized && imageDataArray.length === 0) return;

    const historyText = normalized ||
      (imageDataArray.length === 1 ? "[Cliente envió una foto]" : `[Cliente envió ${imageDataArray.length} fotos]`);

    addMsg(from, "user", historyText);

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
              // v19 (16 sept 2026) — FIX: antes, si guardarMedia() devolvía
              // null (falla interna ya logueada allá, pero sin visibilidad
              // acá), este .then() seguía adelante en silencio con
              // driveUrl:"" — exactamente el "Falta driveUrl" que se ve en
              // el CRM. Ahora se deja un warning explícito con el teléfono
              // y mediaId afectados, para poder rastrear cuál foto quedó
              // sin enlace y por qué (ver el log de guardarMedia arriba,
              // que sí imprime la causa real — típicamente falta de cuota
              // de Drive del service account si MEDIA_FOLDER_ID no apunta
              // a una Unidad Compartida).
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
    // v19 (16 sept 2026) — PAUSA MANUAL: Darwin tomó el control de ESTA
    // conversación desde el CRM. El mensaje del cliente ya quedó guardado en
    // memoria arriba (así que sigue viéndose en el chat del CRM en tiempo
    // real) — pero Sasha no genera ninguna respuesta automática mientras
    // dure la pausa. Cualquier otro cliente sigue recibiendo respuesta
    // normal — esto es por teléfono, no global.
    // ══════════════════════════════════════════════════════════════════════
    if (!esSupervisor && estaEnPausaManual(fromE164)) {
      console.log(`⏸️ Conversación con ${fromE164} en pausa manual (Darwin tiene el control) — Sasha no responde.`);
      return;
    }

// ══════════════════════════════════════════════════════════════════════
// v20 — RESPUESTA A LISTA INTERACTIVA DE AGENDA
//
// Si el cliente tocó una fecha de la lista enviada por Sasha, server.js
// entrega acá un ID como:
//
//   agenda_fecha_2026-09-21
//
// Ese ID NO se manda a Claude para que adivine qué significa.
// El backend extrae la fecha, vuelve a consultar Google Calendar y solo
// acepta la selección si el slot continúa realmente disponible.
//
// IMPORTANTE:
// Esta verificación NO crea todavía la cita.
// createVisitEvent() hará la validación definitiva inmediatamente antes
// de insertar el evento.
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

    // ── La fecha se ocupó mientras el cliente decidía ─────────────────
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

    // ── La fecha sigue libre ──────────────────────────────────────────
    // Guardamos la elección en la sesión. La hora es fija: 09:00.
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

    // El ID técnico ya quedó registrado como mensaje entrante antes de
    // llegar a este punto. Agregamos además una representación humana a
    // la conversación para que el siguiente turno tenga contexto claro.
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

let siguientePregunta = "";

if (datosFaltantes.length > 0) {
  siguientePregunta =
    `Para completar la visita todavía necesito ${datosFaltantes.join(", ")}.`;
} else {
  siguientePregunta =
    "Ya tengo los datos necesarios para completar la solicitud de visita.";
}

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
          
   // ═══════════════════════════════════════════════════════════════════════════════
// v20 — DISPONIBILIDAD REAL DE VISITAS
//
// Google Calendar es la única fuente de verdad.
// proximosDiasHabiles() NO se utiliza para decirle al cliente que una fecha
// está disponible.
//
// Hay tres escenarios:
// 1. Pregunta genérica de disponibilidad → consultamos Calendar y mostramos
//    lista interactiva con fechas realmente libres.
// 2. Pregunta por día/fecha no hábil → explicamos la regla y mostramos fechas
//    realmente libres.
// 3. Pregunta por fecha/día hábil concreto → getAvailableSlots() comprueba
//    específicamente ese día.
//
// La selección agenda_fecha_YYYY-MM-DD ya fue interceptada ARRIBA y nunca
// llega a este bloque.
// ═══════════════════════════════════════════════════════════════════════════════
const dayMentioned = detectDayOrDate(normalized);
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

      // Ya respondimos directamente mediante la lista interactiva.
      // No necesitamos que Claude invente/redacte opciones adicionales.
      return;
    }

    // Si Calendar respondió correctamente pero no encontró fechas, el helper
    // ya informó al cliente. No continuar hacia Claude.
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

  // ───────────────────────────────────────────────────────────────────────
  // CASO A — Día no hábil
  // ───────────────────────────────────────────────────────────────────────
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

      // Tanto si encontró fechas como si no, enviarListaFechasAgenda()
      // ya respondió al cliente.
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

    // ─────────────────────────────────────────────────────────────────────
    // CASO B — Día/fecha potencialmente hábil.
    // Consultamos específicamente Calendar.
    // ─────────────────────────────────────────────────────────────────────
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

      // ── La fecha concreta NO está disponible ──────────────────────────
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

        // ── La fecha concreta SÍ está disponible ─────────────────────────
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

    // ── Llamar a Claude ───────────────────────────────────────────────────────
    const rawResponse = await ask(session.history.slice(0, -1), normalized + availabilityContext, imageData);
    const { cleanMessage, flag, flagData } = parseFlags(rawResponse);

    // ══════════════════════════════════════════════════════════════════════
    // v13/v14 — FIX CRÍTICO: para el flag VISITA, el texto de Claude
    // (cleanMessage) podía incluir una confirmación ("¡Todo listo!")
    // escrita ANTES de intentar crear el evento real en Calendar. Enviarlo
    // de inmediato significa confirmarle al cliente una cita que todavía
    // no sabemos si existe — exactamente lo que pasó con Omar Quesada
    // (se le dijo "Todo listo" y el evento chocó con slot_ocupado).
    // v13 descartaba cleanMessage por completo, pero ese texto también trae
    // la mini-guía de preparación (ONBOARDING POST-AGENDAMIENTO en
    // claude.js), que sí es información útil y legítima. v14: el system
    // prompt (claude.js) ahora le prohíbe explícitamente a Claude afirmar
    // éxito en ese mensaje, así que cleanMessage SÍ se envía — pero como un
    // mensaje aparte, ANTES de intentar la reserva. El resultado real
    // (éxito o rechazo) llega DESPUÉS, en un segundo mensaje construido
    // exclusivamente a partir de lo que devuelve createVisitEvent() — nunca
    // de lo que Claude haya escrito de antemano. Para el resto de los
    // flags, el comportamiento es idéntico al original.
    // ══════════════════════════════════════════════════════════════════════
    if (flag === "VISITA") {
      const [name, project, zone, day, hour, ubicacion, email] = (flagData || "").split("|");

      // ══════════════════════════════════════════════════════════════════
      // v17 (11 sept 2026) — GUARDA DE IDEMPOTENCIA: FIX CRÍTICO
      //
      // BUG REAL: después de confirmar exitosamente la visita de Shirley
      // Vargas (viernes 18 de septiembre, 9:00 a.m.), la clienta respondió
      // simplemente "Gracias". Ese mensaje —sin mencionar ningún día, sin
      // pedir ningún cambio— disparó una SEGUNDA emisión del flag
      // [VISITA:...] con el MISMO día y hora ya confirmados, lo que volvió
      // a invocar createVisitEvent() para una cita que YA EXISTÍA. El
      // evento chocó contra sí mismo (mitigado aparte en calendar.js v16),
      // y Sasha terminó diciéndole a la clienta que su propia cita recién
      // confirmada "ya no estaba disponible" — con el agravante de que
      // luego ofreció fechas inválidas, arruinando la experiencia.
      //
      // FIX: si la visita de este cliente YA está confirmada
      // (session.visit_confirmed === true) y el nuevo flag trae el MISMO
      // día y la MISMA hora que ya están guardados en la sesión, se ignora
      // por completo — nunca se vuelve a llamar createVisitEvent(). Si el
      // cliente de verdad pide otro día/hora, day/hour serán distintos a
      // los guardados y el flujo de reagendamiento sigue funcionando
      // exactamente igual que siempre (createVisitEvent ya maneja
      // reagendamientos vía cancelClientEvents()).
      // ══════════════════════════════════════════════════════════════════

     // ════════════════════════════════════════════════════════════════════
// v20 — BLINDAJE FINAL DE FECHA/HORA
//
// Si el cliente escogió una fecha mediante la agenda interactiva,
// session.visit_day contiene un ISO YYYY-MM-DD verificado por backend.
//
// Claude NO tiene autoridad para sustituir esa fecha por otra al emitir
// [VISITA:...]. Si existe una selección ISO en sesión, esa fecha manda.
//
// Para clientes, la hora oficial de visita es siempre 09:00.
// ════════════════════════════════════════════════════════════════════

      const fechaAgendaBackend =
  String(session.agenda_selected_date || "").trim();

const fechaVisitDayLegacy =
  String(session.visit_day || "").trim();

// agenda_selected_date representa únicamente una selección interactiva
// PENDIENTE de confirmación.
//
// Una vez que ya existe una visita confirmada, esa fecha anterior NO puede
// bloquear una solicitud posterior de reagendamiento.
//
// El fallback a visit_day se conserva únicamente para sesiones antiguas o
// conversaciones que estaban a mitad del flujo antes de implementar
// agenda_selected_date.
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

// ── Guarda de idempotencia v17, ahora usando la fecha/hora DEFINITIVAS ──
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

// IMPORTANTE:
// Todavía NO ponemos visit_confirmed=true.
// Eso solamente ocurrirá DESPUÉS de que Calendar confirme la creación.
const updated = update(from, {
  name:            name?.trim()      || session.name,
  project_desc:    project?.trim()   || session.project_desc,
  zone:            zone?.trim()      || session.zone,
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
  phone:   from,
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

  // v21 — SOLO AHORA la visita puede considerarse confirmada.
  // Calendar ya verificó disponibilidad y creó realmente el evento.
 update(from, {
  visit_confirmed: true,
  lead_saved: true,

  // La selección interactiva ya cumplió su función.
  // La visita real ya existe en Google Calendar.
  agenda_selected_date: null,
});

  updated.visit_confirmed = true;
  updated.lead_saved = true;
  updated.agenda_selected_date = null;

  const nombreDetectado = updated.name || name?.trim();

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

      // ── v14: cleanMessage YA NO se descarta — trae la mini-guía de
      // preparación (ONBOARDING POST-AGENDAMIENTO en claude.js) y ahora el
      // system prompt le prohíbe explícitamente afirmar que la cita ya
      // quedó agendada. Se envía primero, tal cual, como un mensaje
      // separado; el resultado real del backend llega DESPUÉS en un
      // segundo mensaje aparte, nunca reemplazando ni mezclándose con este.
      if (cleanMessage) {
        await sendText(from, cleanMessage);
        addMsg(from, "assistant", cleanMessage);
        if (!esSupervisor) {
          memoria.guardarMensaje({ phone: fromE164, clientName: updated.name || session.name || null, direction: "out", type: "text", content: cleanMessage, session }).catch(() => {});
        }
      }

      // ── El mensaje de RESULTADO se arma SOLO a partir del resultado real
      // del backend — nunca del texto que Claude haya escrito de antemano.
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

        // v13 — nota real para supervisores en vez del último mensaje crudo
        // del cliente (antes podía mostrar, por ejemplo, su correo).
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

      // Monitor supervisores — v14: refleja los DOS mensajes reales que
      // recibió el cliente (la mini-guía de Claude, si la hubo, y el
      // resultado real del backend), en el mismo orden en que se enviaron.
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

      return; // VISITA ya se manejó por completo — no seguir al flujo genérico.
    }

    // ── Flujo genérico (todo lo que NO es VISITA) — sin cambios ───────────────
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

    // ── Procesar flags (VISITA ya se manejó arriba y salió con `return`) ──────
    if (flag === "ESCALAR") {
      update(from, { escalated: true });
      await sendText(from, `📞 Le conecto ahora con *${KNOWLEDGE.empresa.encargado}* de nuestro equipo.`);
      await notifyAllSupervisors(from, session, normalized, "escalacion");

    } else if (flag === "LEAD") {
      const [name, project, zone] = (flagData || "").split("|");
      const updated = update(from, {
        name:         name?.trim()    || session.name,
        project_desc: project?.trim() || session.project_desc,
        zone:         zone?.trim()    || session.zone,
      });

      const nombreDetectado = updated.name || name?.trim();
      if (nombreDetectado) {
        memoria.actualizarNombreInmediato(fromE164, nombreDetectado, {
          proyecto: updated.project_desc || "",
          zona:     updated.zone || "",
        }).catch(() => {});
      }

      if (!session.lead_saved) {
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

  const fromE164 = from.startsWith("+") ? from : `+${from}`;

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
// v11 — REORDEN CRÍTICO: antes se revisaba PRIMERO si el texto contenía
// "lunes"/"martes"/"viernes" como substring, y solo si no había match se
// buscaba una fecha específica. Eso significaba que "el lunes 24 de agosto"
// se detectaba como "lunes" (ignorando la fecha exacta), y el sistema
// calculaba disponibilidad para el PRÓXIMO lunes desde hoy — que puede NO
// ser el 24. Ahora se busca PRIMERO una fecha específica (más precisa); el
// nombre de día es el fallback. También se agregan miércoles/jueves/sábado/
// domingo para que ningún día no hábil quede "invisible" para el detector.
// v12 — también se reconoce "hoy"/"mañana" explícitos, para que un cliente
// que pregunta SOLO "¿tienen espacio hoy?" (sin mencionar un día de la
// semana) sí dispare la verificación de disponibilidad — antes quedaba sin
// ningún [SISTEMA:...] y Sasha no tenía ningún dato verificado para responder.
// v13 — se agrega detección de preguntas de disponibilidad GENÉRICAS (sin
// día, fecha, ni hoy/mañana) → devuelve el sentinel "GENERICO", manejado en
// handleMessage con los próximos días hábiles reales.
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

  // 3) v12 — "hoy"/"mañana" explícitos, mapeados al día hábil más cercano
  // (getNextAvailableDate ya garantiza, con el fix de calendar.js v12, que
  // nunca va a devolver hoy mismo — así que no hay riesgo de terminar
  // agendando same-day por este camino).
  if (n.includes("hoy")) return nearestBusinessDayName();
  if (n.includes("manana") || n.includes("mañana")) return nearestBusinessDayName();

  // 4) v13 — pregunta de disponibilidad genérica, sin día/fecha puntual.
  if (PALABRAS_DISPONIBILIDAD_GENERICA.some(p => n.includes(p.normalize("NFD").replace(/[\u0300-\u036f]/g, "")))) {
    return "GENERICO";
  }

  return null;
}

// v12 — traduce "hoy"/"mañana" al día hábil de visitas (lunes/martes/
// viernes) más cercano, para poder consultar disponibilidad real en vez de
// dejar la pregunta sin ninguna respuesta determinística.
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
