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
 * NUEVO — Detección de comandos por VOZ (audios transcritos):
 *   Se llama memoria.detectarComandoVoz() antes de procesar el texto.
 *   Ejemplo: "gasto de cincuenta mil en materiales" → [GASTO: 50000 | materiales]
 *
 * CONFIGURACIÓN PLANILLA:
 *   PLANILLA_SHEET_ID → ID de la hoja "planilla madre" del sistema operativo SSR
 *   CAJA_TAB          → "CAJA_GENERAL" (libro de caja con saldo en cascada)
 *   AUDIT_TAB         → "AUDIT_LOG" (rastro histórico de movimientos)
 *
 * ── CAMBIOS v3 — FIX AUDIO SUPERVISOR ──────────────────────────────────────────
 * BUG: server.js envuelve las transcripciones de audio interno con
 *   `[Instrucción de voz de supervisor (tel): "texto"]` antes de llamar a
 *   handleMessage. Ese envoltorio completo (corchetes, paréntesis, comillas)
 *   se pasaba TAL CUAL a esComandoFinanciero/procesarComandoFinanciero, lo
 *   que rompía la detección de monto/tipo/proyecto/descripción incluso con
 *   finanzas.js funcionando bien para texto limpio.
 * FIX: desenvolverInstruccionVoz(texto) extrae solo la transcripción real
 *   ANTES de evaluar comandos financieros. El resto del pipeline (Claude
 *   conversacional, memoria, logs) sigue viendo el texto envuelto completo,
 *   porque ahí sí aporta contexto útil.
 *
 * ── CAMBIOS v4 — LECTURA DE COMPROBANTES BANCARIOS POR IMAGEN ──────────────────
 * NUEVO: si un supervisor manda una foto (con o sin texto), se intenta leer
 *   como comprobante bancario (SINPE/BAC) ANTES de cualquier otro flujo.
 *   Si la imagen no es un comprobante reconocible, cae al flujo normal
 *   (foto de obra, conversación con Claude, etc.) sin interrumpir nada.
 *
 * ── CAMBIOS v6 — LENGUAJE NATURAL FINANCIERO DIRECTO A FINANZAS.JS ────────────
 * BUG: el PASO 1 usaba memoria.detectarComandoVoz() para convertir frases
 *   naturales a comandos [GASTO: ...] con regex ANTES de llegar a finanzas.js.
 *   Ese pre-parser masticaba mal los mensajes: "Registra en el proyecto de
 *   Christian la compra de Herrajes de muebles por 89.535,27 Colones" terminó
 *   con descripción ",27", proyecto SSR (perdió "proyecto de Christian") y
 *   monto sin decimales — porque el comando estructurado resultante se procesa
 *   con el parser local simple y NUNCA pasa por Claude.
 * FIX: se elimina la conversión del PASO 1. Todo lenguaje natural financiero
 *   va directo a finanzas.js (procesarComandoFinanciero), que decide solo:
 *   parser local para mensajes cortos e inequívocos, Claude con contexto
 *   completo de proyectos/trabajadores para todo lo demás. Los comandos
 *   estructurados [GASTO:]/[INGRESO:] escritos a mano siguen funcionando
 *   igual (PASO 3).
 *
 * ── CAMBIOS v5 — SANITIZACIÓN DE ERRORES DEL WEBHOOK (Apps Script) ────────────
 * BUG: cuando el webhook de Apps Script devuelve error (404 por URL de
 *   implementación vieja, redirect de login, etc.), finanzas.js incrusta el
 *   HTML completo de Google en el mensaje de error, y Sasha se lo mandaba
 *   tal cual al supervisor (páginas enteras de <!DOCTYPE html>... en WhatsApp).
 * FIX: sanitizarRespuestaFinanciera() detecta HTML en cualquier respuesta
 *   financiera ANTES de enviarla por WhatsApp y la reemplaza por un mensaje
 *   corto y accionable. El HTML crudo queda solo en los logs de Railway para
 *   diagnóstico. Se aplica en TODOS los puntos de salida financieros:
 *   comprobantes por imagen (v4), finanzas naturales (PASO 1B) y comandos
 *   estructurados [GASTO]/[INGRESO].
 * BONUS: corregido doble-escape en registrarFinanzasConCopia /
 *   extraerComandoEstructurado ("\\n" literal en mensajes de ayuda y regex
 *   /\\]\\s*$/ que nunca quitaba el "]" final del comando).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { google }                     = require("googleapis");
const { get, update, addMsg, reset } = require("./state");
const { ask }                        = require("./claude");
const { sendText, markRead, downloadMedia, sendMediaById } = require("./messenger");
const { createVisitEvent, getAvailableSlots, cancelEventByNameAndDate } = require("./calendar");
const { sendVisitConfirmation }      = require("./email");
const { upsertLead, registerVisit }  = require("./crm");
const KNOWLEDGE                      = require("./knowledge");
const memoria                        = require("./memoria");
const { procesarComandoFinanciero, esComandoFinanciero, procesarComprobanteImagen } = require("./finanzas");
const { guardarSolicitante, guardarProveedor, PASOS_SOLICITANTE, PASOS_PROVEEDOR } = require("./rrhh");

// ── Constantes ────────────────────────────────────────────────────────────────
const SUPERVISORES = ["+50683091817", "+50671981370"];

// Número de Darwin — recibe copia de todo movimiento financiero registrado por otros.
const DARWIN_PHONE = "+50683091817";

// ── FIX v3 — Desenvolver instrucciones de voz antes del parser financiero ────
// server.js envuelve las transcripciones de audio de supervisores así:
//   [Instrucción de voz de supervisor (50683091817): "texto real transcrito"]
// Esta función extrae SOLO "texto real transcrito" cuando ese envoltorio está
// presente. Si el texto no tiene el envoltorio (mensaje escrito normal, o
// fallback de transcripción fallida), lo devuelve sin cambios.
function desenvolverInstruccionVoz(texto) {
  if (!texto) return texto;
  const m = texto.match(/^\[Instrucci[oó]n de voz de supervisor\s*\([^)]*\):\s*"([\s\S]*)"\]$/i);
  return m ? m[1].trim() : texto;
}

// ── NUEVO v5 — Sanitizar respuestas financieras antes de enviarlas ───────────
// Si el webhook de Apps Script falla (404 por URL de implementación vieja,
// redirect de login de Google, error 500, etc.), finanzas.js puede devolver
// un error que incluye el HTML completo de la página de Google. Enviar eso
// por WhatsApp es ilegible y confunde al supervisor. Esta función detecta
// HTML en la respuesta y lo reemplaza por un mensaje corto y accionable.
// El detalle técnico completo queda en los logs de Railway.
function sanitizarRespuestaFinanciera(respuesta) {
  if (!respuesta) return respuesta;

  const contieneHTML = /<!DOCTYPE|<html|<head|<body|<meta\s/i.test(respuesta);

  if (!contieneHTML) {
    // Aun sin HTML, truncar errores absurdamente largos por si acaso.
    return respuesta.length > 1500 ? respuesta.slice(0, 1500) + "…" : respuesta;
  }

  // Loguear el error crudo para diagnóstico (solo los primeros 500 chars).
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
  if (quienRegistro === DARWIN_PHONE) return;
  if (!respuesta) return;
  const esConfirmacion = /^[✅💸💰]/.test(respuesta.trim());
  if (!esConfirmacion) return;
  // ...
}

// Planilla madre del sistema operativo SSR
const PLANILLA_SHEET_ID = "1txCpYo8h30i_GW-aa0M59AwsukgRr3rjlKbgRguz9eA";

// Pestaña de caja real (libro de movimientos con saldo en cascada).
// Columnas: FECHA | TIPO | PROYECTO | DESCRIPCIÓN | ENTRADA | SALIDA | SALDO | RESPONSABLE
const CAJA_TAB  = "CAJA_GENERAL";
// Rastro de auditoría (donde Sasha registraba históricamente todos los movimientos).
// Columnas: Timestamp | Tipo | Descripcion | Monto | Proyecto | Categoria | Canal | Pestanas | Confianza_IA | Personal
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
    "+50670068477": "Mauricio",
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
//
// IMPORTANTE:
// Este index.js ya NO escribe directamente en una pestaña OPERACIONES ni solo en
// CAJA_GENERAL. Todo gasto/ingreso pasa por finanzas.js, que manda el POST al
// Apps Script y deja los datos en:
//   - GASTOS_PROYECTO + CAJA_GENERAL para gastos
//   - INGRESOS_CLIENTES + CAJA_GENERAL para ingresos
//
// Esto mantiene el Dashboard alineado con la planilla madre.

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
// Envía un mensaje directo desde SSR a un cliente específico.
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
    // Es un número de teléfono
    phoneDestino  = soloDigitos.startsWith("506") ? `+${soloDigitos}` : `+506${soloDigitos}`;
    nombreCliente = destinatario;
  } else {
    // Es un nombre — buscar en memoria de conversaciones
    const rowsMem = await memoria.buscarPorNombre(destinatario, 5).catch(() => []);
    if (rowsMem.length > 0) {
      const tel = (rowsMem[0][1] || "").replace(/\D/g, "");
      phoneDestino  = tel.startsWith("506") ? `+${tel}` : `+506${tel}`;
      nombreCliente = rowsMem[0][2] || destinatario;
    } else {
      // Buscar en CRM
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

    // Registrar en memoria como mensaje saliente de SSR
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
// Permite a un supervisor agendar una visita en nombre de un cliente específico.
// Si el primer campo es un teléfono (8+ dígitos), se usa como cliente.
// Si no, funciona igual que el flag VISITA normal (para el número del supervisor).
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

  // Detectar si el primer campo es teléfono
  const primerCampo  = partes[0].replace(/\D/g, "");
  const esTelefono   = primerCampo.length >= 8;

  let telefonoCliente, name, project, zone, day, hour, ubicacion, email;

  if (esTelefono) {
    const telClean   = primerCampo.startsWith("506") ? primerCampo : `506${primerCampo}`;
    telefonoCliente  = `+${telClean}`;
    [, name, project, zone, day, hour, ubicacion, email] = partes;
  } else {
    telefonoCliente = supervisorPhone; // fallback — calendario queda en nombre del supervisor
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

    // Notificar al cliente si es un teléfono real (no el del supervisor)
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
// CANCELAR CITA — detección por lenguaje natural
// ═══════════════════════════════════════════════════════════════════════════════
async function detectarYCancelarCita(text) {
  const n = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const esCancelacion = /\b(cancel|borr[ae]|elimin|quit)\w*\b/.test(n) &&
                        /\b(cita|visita|evento|reuni[on]|agend)\w*\b/.test(n);

  if (!esCancelacion) return null;

  let dateHint = null;
  const fechaPatterns = [
    /\b(ma[nñ]ana)\b/,
    /\b(hoy)\b/,
    /\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/,
    /(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/,
    /\b(\d{1,2})\/(\d{1,2})\b/,
  ];
  for (const re of fechaPatterns) {
    const m = n.match(re);
    if (m) { dateHint = m[0].trim(); break; }
  }

  let nameHint = null;
  const conMatch = text.match(/\bcon\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/i);
  const deMatch  = text.match(/\bde\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/i);
  const aMatch   = text.match(/\ba\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/i);

  if (conMatch)      nameHint = conMatch[1].trim();
  else if (deMatch)  nameHint = deMatch[1].trim();
  else if (aMatch)   nameHint = aMatch[1].trim();

  const EXCLUDE = ["manana","mañana","hoy","la","el","los","las","una","un",
                   "cita","visita","evento","lunes","martes","miercoles",
                   "jueves","viernes","sabado","domingo"];
  const nameNorm = (nameHint || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (nameHint && EXCLUDE.includes(nameNorm)) nameHint = null;

  console.log(`🗑️ Cancelación — nombre: "${nameHint || "—"}", fecha: "${dateHint || "—"}"`);

  if (!nameHint && !dateHint) {
    return `⚠️ No entendí bien. Decime el nombre del cliente o la fecha.\n\nEjemplos:\n• *cancela la cita de mañana con Gabriela*\n• *borra la visita del viernes con Roxana*\n• *elimina la cita del 6 de junio*`;
  }

  try {
    const result = await cancelEventByNameAndDate({ nameHint, dateHint });
    if (result.deleted === 0) {
      const quien  = nameHint ? ` de *${nameHint}*` : "";
      const cuando = dateHint ? ` para el *${dateHint}*` : "";
      return `📭 No encontré ninguna cita${quien}${cuando}.\n\nVerificá el nombre o la fecha e intentá de nuevo.`;
    }
    const lineas = result.events.map(e => `• ${e.summary} — ${e.dateStr}`).join("\n");
    const plural = result.deleted > 1;
    return `✅ *${plural ? `${result.deleted} citas canceladas` : "Cita cancelada"}* y eliminada${plural ? "s" : ""} del calendario:\n\n${lineas}`;
  } catch (err) {
    console.error("❌ Error cancelando cita:", err.message);
    return `❌ Error al cancelar la cita: ${err.message}`;
  }
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

  // ── NUEVO v4: lectura de comprobantes bancarios por imagen ─────────────────
  // Se ejecuta ANTES de cualquier otro flujo, con o sin texto acompañando la
  // foto. Si la imagen resulta ser un comprobante bancario reconocible, se
  // registra el movimiento y se corta acá. Si no lo es (foto de obra, por
  // ejemplo), sigue de largo al flujo normal más abajo sin ninguna interrupción.
  if (esSupervisor && mediaIds) {
    const idsComprobante = Array.isArray(mediaIds) ? mediaIds : [mediaIds];
    for (const id of idsComprobante) {
      try {
        const imgData = await downloadMedia(id);
        if (!imgData) continue;

        const respuestaComprobante = await procesarComprobanteImagen(imgData.base64, imgData.mimeType, normalized);

        if (respuestaComprobante && !respuestaComprobante.startsWith("📭")) {
          // v5: nunca mandar HTML del webhook al chat
          const respuestaLimpia = sanitizarRespuestaFinanciera(respuestaComprobante);
          await sendText(from, respuestaLimpia);
          await copiaFinancieraADarwin(fromE164, respuestaLimpia);
          return;
        }
        // Si no era comprobante bancario, seguimos al flujo normal (foto de obra, chat, etc.)
      } catch (err) {
        console.error("❌ Error procesando imagen de comprobante:", err.message);
      }
    }
  }

  if (esSupervisor && normalized) {

    // ── FIX v3: desenvolver instrucción de voz ANTES de evaluar comandos
    // financieros. server.js envuelve las transcripciones de audio interno
    // con [Instrucción de voz de supervisor (tel): "texto"] — ese envoltorio
    // rompía la detección de monto/tipo/proyecto en finanzas.js porque los
    // corchetes, paréntesis y comillas contaban como parte del mensaje.
    // textoFinanciero = solo la transcripción real, para usar SOLO en los
    // pasos 1, 1B y 3 (todo lo relacionado a GASTO/INGRESO). El resto del
    // pipeline (Claude conversacional, memoria, cancelación de citas) sigue
    // usando "normalized" completo, con el envoltorio, porque ahí el contexto
    // de "esto es audio de supervisor" sigue siendo útil.
    const textoFinanciero = desenvolverInstruccionVoz(normalized);

    // ── PASO 1 (v6): Finanzas en lenguaje natural → DIRECTO a finanzas.js ─────
    // Ya NO se pre-convierte con memoria.detectarComandoVoz() — ese pre-parser
    // de regex masticaba mal los mensajes (descripción ",27", proyecto perdido)
    // y el comando resultante se saltaba a Claude. finanzas.js decide solo:
    // parser local para mensajes cortos e inequívocos, Claude con contexto
    // completo de proyectos para todo lo demás.
    const cmd = normalized;

    if (!/^\[(GASTO|INGRESO):/i.test(cmd) && esComandoFinanciero(textoFinanciero)) {
      const respuesta = await procesarComandoFinanciero(textoFinanciero);
      if (respuesta) {
        // v5: nunca mandar HTML del webhook al chat
        const respuestaLimpia = sanitizarRespuestaFinanciera(respuesta);
        await sendText(from, respuestaLimpia);
        await copiaFinancieraADarwin(fromE164, respuestaLimpia);
        return;
      }
    }

    // ── PASO 2: Cancelar cita (lenguaje natural) ──────────────────────────────
    const cancelResult = await detectarYCancelarCita(cmd);
    if (cancelResult !== null) {
      await sendText(from, cancelResult);
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
    // Supervisor agendando una visita en nombre de un cliente específico
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
    // El supervisor puede hacer preguntas generales a Sasha
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
