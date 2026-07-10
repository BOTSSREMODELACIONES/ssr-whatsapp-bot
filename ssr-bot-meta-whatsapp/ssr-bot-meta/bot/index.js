/**
 * index.js — Orquestador principal de mensajes para Sasha
 * SS Remodelaciones
 *
 * (Historial de cambios v2–v7: ver versiones anteriores.)
 *
 * ── CAMBIOS v8 — DISPONIBILIDAD REAL + COLA DE VERIFICACIÓN MANUAL ────────────
 * BUG CALENDARIO: Sasha agendaba visitas encima de días bloqueados por un
 *   supervisor (ej: Melvin reservó el día completo para instalar muebles). La
 *   causa: createVisitEvent insertaba el evento sin verificar disponibilidad.
 *   FIX: createVisitEvent (en calendar.js) ahora verifica ANTES de insertar y
 *   devuelve { ok:false, motivo } si el día está bloqueado o el slot ocupado.
 *   Aquí manejamos ese resultado en las 2 rutas que crean visitas (flujo
 *   cliente por flag [VISITA:] y comando de supervisor [VISITA:...]).
 *
 * VERIFICACIÓN MANUAL DE VISITAS REMOTAS / EXTRANJERAS (seguridad de personal):
 *   En vez de bloquear países por prefijo (que pierde clientes legítimos y no
 *   protege de verdad), las solicitudes de visita que (a) vienen de un prefijo
 *   telefónico extranjero, o (b) mencionan finca / rancho / zona remota, NO se
 *   auto-agendan: se marcan para revisión humana y se avisa a los supervisores
 *   con los datos, para que un humano apruebe antes de enviar a cualquier
 *   funcionario. Se conserva trazabilidad completa (útil ante una denuncia).
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

const DARWIN_PHONE = "+50683091817";

// ═══════════════════════════════════════════════════════════════════════════════
// v8 — VERIFICACIÓN MANUAL DE VISITAS DE RIESGO
// ═══════════════════════════════════════════════════════════════════════════════
// Prefijos telefónicos considerados EXTRANJEROS para efectos de verificación.
// Costa Rica es +506. Una solicitud de visita desde otro prefijo no se bloquea
// ni se ignora: se manda a revisión humana antes de agendar.
// (Se puede ampliar esta lista según haga falta.)
const PREFIJOS_EXTRANJEROS = ["+52", "+57"];  // México, Colombia

// Palabras que sugieren una visita a zona remota/aislada, donde el riesgo para
// el personal es mayor y conviene verificación humana previa.
const PALABRAS_ZONA_REMOTA = [
  "finca", "fincas", "rancho", "ranchos", "hacienda", "parcela", "parcelas",
  "lote baldio", "zona rural", "montaña", "montana", "potrero", "quinta",
];

function tienePrefijoExtranjero(phoneE164) {
  return PREFIJOS_EXTRANJEROS.some(p => (phoneE164 || "").startsWith(p));
}

function mencionaZonaRemota(texto) {
  const n = (texto || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return PALABRAS_ZONA_REMOTA.some(w =>
    new RegExp(`\\b${w.normalize("NFD").replace(/[\u0300-\u036f]/g, "")}\\b`).test(n)
  );
}

// Decide si una solicitud de visita necesita revisión humana antes de agendar.
// Devuelve null si no hace falta, o un objeto con el/los motivo(s) si sí.
function requiereVerificacionManual({ phoneE164, texto, zona, proyecto }) {
  const motivos = [];
  if (tienePrefijoExtranjero(phoneE164)) motivos.push("número internacional");
  const textoCompleto = [texto, zona, proyecto].filter(Boolean).join(" ");
  if (mencionaZonaRemota(textoCompleto)) motivos.push("visita en zona remota (finca/rancho)");
  return motivos.length ? motivos : null;
}

// Avisa a todos los supervisores que un lead quedó en espera de verificación,
// con los datos para decidir. NO se agenda nada hasta que un humano apruebe.
async function notificarVerificacionManual({ from, session, motivos, ultimoMensaje }) {
  const lines = [
    "🛑 *VISITA EN ESPERA — REQUIERE VERIFICACIÓN HUMANA*",
    "",
    `⚠️ Motivo: ${motivos.join(" + ")}`,
    "",
    `📱 ${from}`,
    session.name         && `👤 ${session.name}`,
    session.project_desc && `🏗️ ${session.project_desc}`,
    session.zone         && `📍 ${session.zone}`,
    session.visit_day    && `📅 Día solicitado: ${session.visit_day}`,
    session.visit_hour   && `🕐 Hora solicitada: ${session.visit_hour}`,
    session.waze_link    && `🗺️ Ubicación: ${session.waze_link}`,
    "",
    ultimoMensaje && `💬 "${ultimoMensaje}"`,
    "",
    "🔒 *No se agendó automáticamente.* Verifiquen identidad y ubicación antes",
    "de enviar a cualquier compañero. Para agendar tras confirmar, usen:",
    "`[VISITA: número | nombre | proyecto | zona | día | hora | ubicación | email]`",
    "",
    "_Sasha — Bot SSR_",
  ].filter(Boolean).join("\n");

  const resultados = await Promise.allSettled(SUPERVISORES.map(num => sendText(num, lines)));
  resultados.forEach((r, i) => {
    if (r.status === "fulfilled") console.log(`✅ Supervisor [${SUPERVISORES[i]}] avisado de verificación manual`);
    else console.error(`❌ Error avisando verificación a ${SUPERVISORES[i]}: ${r.reason?.message}`);
  });
}

// Mensaje neutral al cliente cuando su visita queda en revisión. No revela el
// motivo (no acusa a nadie); simplemente dice que el equipo confirmará.
function mensajeClienteEnRevision(nombre) {
  return [
    nombre ? `Gracias ${nombre}. 🙏` : "¡Gracias! 🙏",
    "",
    "Su solicitud de visita quedó registrada. Para este tipo de proyecto, un",
    "miembro de nuestro equipo le contactará personalmente para confirmar los",
    "detalles y coordinar la fecha. Le escribimos muy pronto 😊",
  ].join("\n");
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

async function copiaFinancieraADarwin(quienRegistro, respuesta) {
  if (quienRegistro === DARWIN_PHONE) return;
  if (!respuesta || !respuesta.startsWith("✅")) return;
  const quien = nombreSupervisor(quienRegistro);
  const copia = `📋 *Copia — movimiento registrado por ${quien}*\n\n${respuesta}`;
  sendText(DARWIN_PHONE, copia).catch(err =>
    console.warn("⚠️ No se pudo enviar copia financiera a Darwin:", err.message)
  );
}

const PLANILLA_SHEET_ID = "1txCpYo8h30i_GW-aa0M59AwsukgRr3rjlKbgRguz9eA";

const CAJA_TAB  = "CAJA_GENERAL";
const AUDIT_TAB = "AUDIT_LOG";

const TZ = "America/Costa_Rica";

const IGNORAR         = [];
// v8: ya NO se bloquean prefijos por país. Las visitas de riesgo (extranjeras
// o remotas) se envían a verificación humana en vez de ignorarse en silencio.
// Se conserva la lista de ignorados exactos por si hace falta silenciar un
// número puntual abusivo (spam directo), pero NO se filtra por país.
const IGNORAR_PREFIJOS = [];

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

function fmtColones(n) {
  if (n === null || n === undefined || isNaN(n)) return String(n ?? "");
  return Math.round(n).toLocaleString("de-DE");
}

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

    return sanitizarRespuestaFinanciera(respuesta);
  } catch (err) {
    console.error(`❌ registrarFinanzasConCopia ${tipo}:`, err.message, err.stack);
    return sanitizarRespuestaFinanciera(`❌ No se pudo registrar el ${tipo.toLowerCase()}: ${err.message}`);
  }
}

async function handleGasto(cmd, supervisorPhone) {
  return await registrarFinanzasConCopia("GASTO", cmd, supervisorPhone);
}

async function handleIngreso(cmd, supervisorPhone) {
  return await registrarFinanzasConCopia("INGRESO", cmd, supervisorPhone);
}

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
// v8: maneja el resultado { ok:false } de createVisitEvent (día bloqueado /
// slot ocupado). Este comando lo usa un SUPERVISOR, así que es una decisión
// humana consciente — por eso NO se manda a verificación de riesgo, pero SÍ
// se respeta el bloqueo de calendario para no duplicar/pisar citas.
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

    // v8: el calendario rechazó la creación (día bloqueado o slot ocupado)
    if (eventData && eventData.ok === false) {
      if (eventData.motivo === "dia_bloqueado") {
        return [
          `⛔ *No se agendó — día bloqueado*`,
          ``,
          `El día solicitado está reservado${eventData.conflicto ? ` ("${eventData.conflicto}")` : ""}.`,
          `Elegí otro día (lunes, martes o viernes) libre para *${name}*.`,
        ].join("\n");
      }
      if (eventData.motivo === "slot_ocupado") {
        return [
          `⛔ *No se agendó — horario ocupado*`,
          ``,
          `Ya hay una cita en ese horario${eventData.conflicto ? ` ("${eventData.conflicto}")` : ""}.`,
          `Probá con otra hora (09:00, 11:30 o 14:00) para *${name}*.`,
        ].join("\n");
      }
      return [
        `⚠️ *No se pudo verificar el calendario*`,
        ``,
        `Por seguridad no agendé la cita a ciegas. Revisá la conexión con Google`,
        `Calendar e intentá de nuevo en un momento.`,
      ].join("\n");
    }

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
// GESTIÓN DE CALENDARIO PARA SUPERVISORES (cancelar/reagendar/consultar)
// ═══════════════════════════════════════════════════════════════════════════════
function mencionaCalendario(texto) {
  const n = (texto || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const hablaDeCitas   = /\b(cita|citas|visita|visitas|evento|eventos|reunion|reuniones|agenda|calendario)\b/.test(n);
  const tieneAccion    = /\b(cancel|borr|elimin|quit|cambi|mov[ea]|move|pas[aá]|reagend|reprogram|corr[ea]|adelant|atras|que|cual|cuales|hay|tengo|tenemos|mostr|dame|decime|dime|lista|ver)\w*\b/.test(n);
  return hablaDeCitas && tieneAccion;
}

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

async function gestionarCalendarioSupervisor(texto, supervisorPhone) {
  if (!mencionaCalendario(texto)) return null;

  const intent = await interpretarComandoCalendario(texto);
  if (!intent || intent.accion === "ninguna") return null;

  const quien = nombreSupervisor(supervisorPhone);

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

      // v8: el destino del reagendamiento está bloqueado u ocupado
      if (result.error === "destino_ocupado") {
        if (result.motivo === "dia_bloqueado") {
          return `⛔ No moví la cita: el día destino está reservado${result.conflicto ? ` ("${result.conflicto}")` : ""}.\n\nElegí otro día libre.`;
        }
        if (result.motivo === "slot_ocupado") {
          return `⛔ No moví la cita: ya hay algo en ese horario${result.conflicto ? ` ("${result.conflicto}")` : ""}.\n\nProbá otra hora (09:00, 11:30 o 14:00).`;
        }
        return `⚠️ No pude verificar el calendario destino. Por seguridad no moví la cita a ciegas. Intentá de nuevo en un momento.`;
      }

      if (result.moved === 0) {
        const q = intent.nombre ? ` de *${intent.nombre}*` : "";
        return `📭 No encontré la cita${q} para mover.\n\nVerificá el nombre o la fecha.`;
      }

      const ev = result.events[0];

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

  // v8: ya NO se bloquea por prefijo de país. Se conserva el mecanismo por si
  // hace falta silenciar un número específico abusivo, pero IGNORAR_PREFIJOS
  // está vacío. La gestión de riesgo de visitas ocurre al momento de agendar
  // (verificación humana), no bloqueando conversaciones enteras.
  if (IGNORAR_PREFIJOS.length && IGNORAR_PREFIJOS.some(p => fromE164.startsWith(p) || from.startsWith(p))) {
    console.log(`🚫 Mensaje silenciado (número en lista): ${from}`);
    return;
  }

  const esSupervisor = SUPERVISORES.includes(fromE164) || SUPERVISORES.includes(from);

  if (esSupervisor && mediaIds) {
    const idsComprobante = Array.isArray(mediaIds) ? mediaIds : [mediaIds];
    for (const id of idsComprobante) {
      try {
        const imgData = await downloadMedia(id);
        if (!imgData) continue;

        const respuestaComprobante = await procesarComprobanteImagen(imgData.base64, imgData.mimeType, normalized);

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

    const textoLimpio = desenvolverInstruccionVoz(normalized);

    const cmd = normalized;

    if (!/^\[(GASTO|INGRESO):/i.test(cmd) && esComandoFinanciero(textoLimpio)) {
      const respuesta = await procesarComandoFinanciero(textoLimpio);
      if (respuesta) {
        const respuestaLimpia = sanitizarRespuestaFinanciera(respuesta);
        await sendText(from, respuestaLimpia);
        await copiaFinancieraADarwin(fromE164, respuestaLimpia);
        return;
      }
    }

    const respCalendario = await gestionarCalendarioSupervisor(textoLimpio, fromE164);
    if (respCalendario !== null) {
      await sendText(from, respCalendario);
      return;
    }

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

    const respuestaMemoria = await memoria.procesarConsultaMemoria(cmd);
    if (respuestaMemoria) {
      await sendText(from, respuestaMemoria);
      return;
    }
  }

  if (session.escalated) return;

  if (session.modo === "solicitante") {
    await handleRRHHFlow(from, normalized, session, "solicitante");
    return;
  }

  if (session.modo === "proveedor") {
    await handleRRHHFlow(from, normalized, session, "proveedor");
    return;
  }

  try {
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

    const rawResponse = await ask(session.history.slice(0, -1), normalized + availabilityContext, imageData);
    const { cleanMessage, flag, flagData } = parseFlags(rawResponse);

    await sendText(from, cleanMessage);
    addMsg(from, "assistant", cleanMessage);

    if (!esSupervisor) {
      memoria.guardarMensaje({ phone: fromE164, clientName: session.name || null, direction: "out", type: "text", content: cleanMessage, session }).catch(() => {});
    }

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

      // ── v8: ¿esta visita requiere verificación humana? ────────────────────
      // Prefijo extranjero (México/Colombia) o mención de finca/rancho/zona
      // remota → NO se auto-agenda. Se avisa a supervisores para que un humano
      // verifique identidad y ubicación antes de enviar a cualquier funcionario.
      const motivosVerif = requiereVerificacionManual({
        phoneE164: fromE164,
        texto:     [normalized, ...(session.history || []).map(h => h.content || "")].join(" "),
        zona:      updated.zone,
        proyecto:  updated.project_desc,
      });

      if (motivosVerif) {
        console.warn(`🛑 Visita en espera de verificación (${motivosVerif.join(", ")}): ${fromE164}`);
        update(from, { visita_en_revision: true, visit_confirmed: false });
        await sendText(from, mensajeClienteEnRevision(updated.name));
        await notificarVerificacionManual({
          from, session: get(from), motivos: motivosVerif, ultimoMensaje: normalized,
        });
        logLead(from, updated, "visita_en_revision");
        return;   // no se agenda, no se crea evento
      }

      const visitHour = updated.visit_hour || "09:00";
      const [hh, mm]  = visitHour.split(":");
      const hourNum   = parseInt(hh);
      const hour12    = hourNum > 12 ? hourNum - 12 : hourNum === 0 ? 12 : hourNum;
      let timeStr     = `${hour12}:${mm} ${hourNum >= 12 ? "p.m." : "a.m."}`;
      let dateStr     = updated.visit_day;

      // ── v8: crear la visita SOLO si el calendario está libre ──────────────
      let visitaAgendada = false;
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

        if (eventData && eventData.ok === false) {
          // Día bloqueado o slot ocupado: NO confirmamos al cliente. Le
          // ofrecemos volver a elegir y avisamos a supervisores.
          console.warn(`⛔ Visita no agendada (${eventData.motivo}) para ${from}`);
          update(from, { visit_confirmed: false, slots_shown: null });

          let msgCliente;
          if (eventData.motivo === "dia_bloqueado") {
            msgCliente = "¡Uy! Ese día justo no tenemos disponibilidad. ¿Le sirve otro día? Trabajamos lunes, martes o viernes 😊";
          } else if (eventData.motivo === "slot_ocupado") {
            msgCliente = "Ese horario ya se ocupó hace un momento. ¿Le sirve otra hora ese día? Tengo 9:00, 11:30 o 2:00 p.m. 😊";
          } else {
            msgCliente = "Disculpe, tuve un problema para confirmar la agenda en este momento. En un ratito le confirmo su cita, ¿le parece? 🙏";
          }
          await sendText(from, msgCliente);

          // Avisar a supervisores del intento fallido (útil con campaña activa)
          for (const sup of SUPERVISORES) {
            sendText(sup, `⚠️ *Intento de cita no agendado*\n\n👤 ${updated.name || "Cliente"} (${from})\n📅 Pidió: ${updated.visit_day} ${timeStr}\n🚫 Motivo: ${eventData.motivo}${eventData.conflicto ? ` ("${eventData.conflicto}")` : ""}\n\nEl cliente puede reintentar con otro horario.`).catch(() => {});
          }
          return;
        }

        dateStr = eventData.startDate.toLocaleDateString("es-CR", {
          weekday: "long", day: "numeric", month: "long", timeZone: TZ,
        });
        visitaAgendada = true;
        console.log(`📅 Visita agendada: ${eventData.eventLink}${eventData.rescheduled ? " (reagendada)" : ""}`);
      } catch (calErr) {
        console.error("❌ Error Calendar:", calErr.message);
      }

      if (!visitaAgendada) {
        // Falla dura de calendario (excepción). No confirmamos en falso.
        await sendText(from, "Disculpe, tuve un inconveniente para confirmar su cita. Un compañero le contactará enseguida para coordinar 🙏");
        await notifyAllSupervisors(from, updated, normalized, "visita_solicitada");
        return;
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
