/**
 * index.js — Orquestador principal de mensajes para Sasha
 * SS Remodelaciones
 *
 * ── CAMBIOS v2 ────────────────────────────────────────────────────────────────
 * NUEVOS handlers para supervisores:
 *   [GASTO: monto | descripcion | proyecto?]   → escribe en CAJA_GENERAL + AUDIT_LOG
 *   [INGRESO: monto | descripcion | proyecto?] → escribe en CAJA_GENERAL + AUDIT_LOG
 *   [MSG_CLIENTE: nombre_o_tel | msg]    → envía mensaje directo a un cliente
 *   [VISITA: tel_cliente | ...]          → agenda visita asociada a teléfono de cliente
 *   [RESUMEN_CLIENTE: nombre]            → acceso directo al resumen IA
 *
 * ── CAMBIOS v3 — FIX AUDIO SUPERVISOR ──────────────────────────────────────────
 * desenvolverInstruccionVoz(texto) extrae solo la transcripción real del
 * envoltorio [Instrucción de voz de supervisor (tel): "texto"] ANTES de
 * evaluar comandos financieros.
 *
 * ── CAMBIOS v4 — LECTURA DE COMPROBANTES BANCARIOS POR IMAGEN ──────────────────
 * ── CAMBIOS v5 — SANITIZACIÓN DE ERRORES DEL WEBHOOK (Apps Script) ────────────
 * ── CAMBIOS v6 — LENGUAJE NATURAL FINANCIERO DIRECTO A FINANZAS.JS ────────────
 * (ver historial en versiones anteriores)
 *
 * ── CAMBIOS v7 — GESTIÓN DE CALENDARIO PARA SUPERVISORES ──────────────────────
 * BUG 1: detectarYCancelarCita() recibía el texto CON el envoltorio de voz
 *   [Instrucción de voz de supervisor (506...): "cancela la cita..."] — los
 *   corchetes/paréntesis rompían la extracción de nombre y fecha. Por eso
 *   los comandos de calendario por AUDIO nunca funcionaban.
 * BUG 2: no existía ninguna función para REAGENDAR una cita. "Cambia la cita
 *   de Gabriela para el viernes" no hacía nada.
 * FIX: nuevo módulo gestionarCalendarioSupervisor() que:
 *   - Usa el texto DESENVUELTO (igual que finanzas) → funciona por audio.
 *   - Detecta 3 intenciones: CANCELAR, REAGENDAR y CONSULTAR agenda.
 *   - Interpreta con Claude (JSON estructurado) cuando el mensaje menciona
 *     citas/visitas/agenda — entiende lenguaje natural real, no solo regex.
 *   - Fallback a regex local si Claude falla (sin API no se cae nada).
 *   - REAGENDAR: usa rescheduleEventByNameAndDate() nueva en calendar.js.
 *     Si hay varias citas que coinciden, pide especificar (no mueve a ciegas).
 *   - Notifica automáticamente al cliente por WhatsApp cuando su cita se
 *     cancela o se mueve (el teléfono se extrae de la descripción del evento).
 *     Se puede silenciar diciendo "sin avisar al cliente".
 *
 * ── CAMBIOS v8 — CONTEXTO PUENTE TEXTO→IMAGEN PARA COMPROBANTES ───────────────
 * BUG: cuando un supervisor escribe "Registra este gasto de combustible para
 *   el proyecto de Christian" y LUEGO manda la foto del comprobante SINPE,
 *   WhatsApp los entrega como DOS mensajes/webhooks independientes:
 *     1) el texto solo → dispara procesarComandoFinanciero() SIN monto →
 *        "❌ Monto inválido: ..." (Claude sí detecta el proyecto pero no
 *        tiene el monto, que está en la imagen que aún no llegó).
 *     2) la imagen sola → dispara procesarComprobanteImagen() SIN el texto
 *        original (WhatsApp no reenvía el caption si se mandó por separado)
 *        → el "Detalle" del banco casi nunca menciona el proyecto → cae a
 *        SSR por defecto, aunque el supervisor SÍ dijo el proyecto.
 * FIX: pendingReceiptContext — buffer en memoria por número de supervisor.
 *   - Si un comando financiero de TEXTO no trae monto (esComandoFinanciero
 *     true pero sin dígitos), NO se manda a procesarComandoFinanciero (que
 *     generaría el error falso). En su lugar se guarda como contexto
 *     pendiente con timestamp, y se responde con un acuse corto pidiendo
 *     la foto — no un error.
 *   - Cuando llega una IMAGEN de ese mismo supervisor dentro de los
 *     siguientes 3 minutos, se fusiona el texto pendiente con el caption
 *     de la imagen (si lo hay) antes de llamar a procesarComprobanteImagen,
 *     y se limpia el buffer.
 *   - Contexto pendiente > 3 min se descarta automáticamente (evita que un
 *     comentario viejo se pegue a un comprobante no relacionado).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { google }                     = require("googleapis");
const { get, update, addMsg, reset } = require("./state");
const { ask }                        = require("./claude");
const { sendText, markRead, downloadMedia, sendMediaById } = require("./messenger");
const { createVisitEvent, getAvailableSlots, cancelEventByNameAndDate,
        rescheduleEventByNameAndDate, listUpcomingEvents } = require("./calendar");
const { sendVisitConfirmation }      = require("./email");
const { upsertLead, registerVisit }  = require("./crm");
const KNOWLEDGE                      = require("./knowledge");
const memoria                        = require("./memoria");
const { procesarComandoFinanciero, esComandoFinanciero, procesarComprobanteImagen } = require("./finanzas");
const { guardarSolicitante, guardarProveedor, PASOS_SOLICITANTE, PASOS_PROVEEDOR } = require("./rrhh");

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
      name, phone: telefonoCliente, project, zone, day, hour,
      wazeLink: ubicacion, clientEmail: email,
    });

    const dateStr = eventData.startDate.toLocaleDateString("es-CR", {
      weekday: "long", day: "numeric", month: "long", timeZone: TZ,
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
        nameHint:    intent.nombre,
        dateHint:    intent.fecha,
        newDateHint: intent.nuevaFecha,
        newHour:     intent.nuevaHora,
      });

      if (result.ambiguous) {
        const lineas = result.events.map(e => `• ${e.summary} — ${e.dateStr}`).join("\n");
        return `⚠️ Encontré *${result.events.length} citas* que coinciden. Especificá mejor (nombre completo o fecha):\n\n${lineas}`;
      }

      if (result.error === "fecha_pasada") {
        return `⚠️ La nueva fecha ya pasó. Indicá una fecha futura.`;
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

  // ── MODO SUPERVISOR ──────────────────────────────────────────────────────────
  const esSupervisor = SUPERVISORES.includes(fromE164) || SUPERVISORES.includes(from);

  // ── v4/v8: lectura de comprobantes bancarios por imagen ──────────────────────
  // v8: se fusiona con cualquier contexto de texto pendiente de ESTE supervisor
  // (ej. "regístrame esto a nombre del proyecto de Christian" mandado como
  // mensaje aparte, segundos antes de la foto).
  if (esSupervisor && mediaIds) {
    const idsComprobante = Array.isArray(mediaIds) ? mediaIds : [mediaIds];
    for (const id of idsComprobante) {
      try {
        const imgData = await downloadMedia(id);
        if (!imgData) continue;

        const contextoPrevio = consumirContextoPendiente(fromE164);
        const textoParaImagen = [contextoPrevio, normalized].filter(Boolean).join(". ").trim();

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

    // ── PASO 1 (v6): Finanzas en lenguaje natural → DIRECTO a finanzas.js ─────
    const cmd = normalized;

    if (!/^\[(GASTO|INGRESO):/i.test(cmd) && esComandoFinanciero(textoLimpio)) {

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
            .then(driveUrl =>
              memoria.guardarMensaje({ phone: fromE164, clientName, direction: "in", type: "image", content: "[Foto enviada por el cliente]", mediaId, driveUrl: driveUrl || "", session }).catch(() => {})
            )
            .catch(() =>
              memoria.guardarMensaje({ phone: fromE164, clientName, direction: "in", type: "image", content: "[Foto enviada por el cliente]", mediaId, driveUrl: "", session }).catch(() => {})
            );
        });
      }
    }

    // ── Detectar día/fecha para disponibilidad ────────────────────────────────
    const dayMentioned = detectDayOrDate(normalized);
    let availabilityContext = "";

    if (dayMentioned && dayMentioned !== session.slots_shown) {
      const slots = await getAvailableSlots(dayMentioned);
      update(from, { slots_shown: dayMentioned });

      if (slots.length === 0) {
        availabilityContext = `\n\n[SISTEMA: El cliente pidió ${dayMentioned} pero NO hay slots disponibles ese día. Explícale amablemente y ofrécele los otros días disponibles: lunes, martes o viernes.]`;
      } else {
        const slotsText = slots.map(s => {
          const [h, m] = s.split(":");
          const hNum   = parseInt(h);
          const h12    = hNum > 12 ? hNum - 12 : hNum;
          return `${h12}:${m} ${hNum >= 12 ? "p.m." : "a.m."}`;
        }).join(", ");
        availabilityContext = `\n\n[SISTEMA: Slots disponibles para ${dayMentioned}: ${slotsText}. Ofrece SOLO estos horarios al cliente. La disponibilidad ya fue verificada — NO digas que vas a verificarla. Si el cliente ya eligió uno, procede INMEDIATAMENTE a pedirle la ubicación.]`;
      }
    }

    // ── Llamar a Claude ───────────────────────────────────────────────────────
    const rawResponse = await ask(session.history.slice(0, -1), normalized + availabilityContext, imageData);
    const { cleanMessage, flag, flagData } = parseFlags(rawResponse);

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

    // ── Procesar flags ────────────────────────────────────────────────────────
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

    } else if (flag === "VISITA") {
      const [name, project, zone, day, hour, ubicacion, email] = (flagData || "").split("|");
      const updated = update(from, {
        name:            name?.trim()      || session.name,
        project_desc:    project?.trim()   || session.project_desc,
        zone:            zone?.trim()      || session.zone,
        visit_day:       day?.trim()       || "a coordinar",
        visit_hour:      hour?.trim()      || "09:00",
        waze_link:       ubicacion?.trim() || "",
        client_email:    email?.trim()     || "",
        visit_confirmed: true,
        lead_saved:      true,
      });

      const nombreDetectado = updated.name || name?.trim();
      if (nombreDetectado) {
        memoria.actualizarNombreInmediato(fromE164, nombreDetectado, {
          proyecto:       updated.project_desc || "",
          zona:           updated.zone || "",
          visitaAgendada: true,
        }).catch(() => {});
      }

      const visitHour = updated.visit_hour || "09:00";
      const [hh, mm]  = visitHour.split(":");
      const hourNum   = parseInt(hh);
      const hour12    = hourNum > 12 ? hourNum - 12 : hourNum === 0 ? 12 : hourNum;
      let timeStr     = `${hour12}:${mm} ${hourNum >= 12 ? "p.m." : "a.m."}`;
      let dateStr     = updated.visit_day;

      try {
        const eventData = await createVisitEvent({
          name:        updated.name,
          phone:       from,
          project:     updated.project_desc,
          zone:        updated.zone,
          day:         updated.visit_day,
          hour:        updated.visit_hour,
          wazeLink:    updated.waze_link,
          clientEmail: updated.client_email,
        });
        dateStr = eventData.startDate.toLocaleDateString("es-CR", {
          weekday: "long", day: "numeric", month: "long", timeZone: TZ,
        });
        console.log(`📅 Visita agendada: ${eventData.eventLink}${eventData.rescheduled ? " (reagendada)" : ""}`);
      } catch (calErr) {
        console.error("❌ Error Calendar:", calErr.message);
      }

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
      await notifyAllSupervisors(from, updated, normalized, "visita_solicitada");
      logLead(from, updated, "visita_solicitada");
      await sendText(from, `✅ ¡Listo! Su cita quedó agendada para el *${dateStr} a las ${timeStr}*. Le llegará una confirmación por correo 📅`);

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
function detectDayOrDate(text) {
  const n = (text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (n.includes("lunes"))   return "lunes";
  if (n.includes("martes"))  return "martes";
  if (n.includes("viernes")) return "viernes";

  const MONTHS = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  for (const mes of MONTHS) {
    const re = new RegExp(`(\\d{1,2})\\s+(?:de\\s+)?${mes}`, "i");
    const m  = n.match(re);
    if (m) return `${m[1]} de ${mes}`;
  }
  const m2 = n.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (m2) return `${m2[1]}/${m2[2]}`;
  return null;
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

module.exports = { handleMessage };
