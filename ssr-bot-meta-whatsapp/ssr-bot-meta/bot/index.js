// bot/index.js — Orquestador principal de Sasha v5
// Cambios v5:
// - Supervisores ya NO salen temprano: pasan por Claude para instrucciones avanzadas
// - Nuevos flags: [GASTO:] [INGRESO:] [MSG_CLIENTE:] [RESUMEN_CLIENTE:]
// - Resúmenes de clientes funcionan por nombre o por número
// - Agendamiento desde supervisor funciona completo incluyendo desde audio

"use strict";

const { get, update, addMsg, reset }               = require("./state");
const { ask }                                       = require("./claude");
const { sendText, markRead, downloadMedia, sendMediaById } = require("./messenger");
const { createVisitEvent, getAvailableSlots }       = require("./calendar");
const { sendVisitConfirmation }                     = require("./email");
const { upsertLead, registerVisit }                 = require("./crm");
const KNOWLEDGE                                     = require("./knowledge");
const memoria                                       = require("./memoria");
const { guardarSolicitante, guardarProveedor, PASOS_SOLICITANTE, PASOS_PROVEEDOR } = require("./rrhh");

// ── Números supervisores ──────────────────────────────────────────────────────
const SUPERVISORES = ["+50683091817", "+50671981370", "+50670068477"];

// Números a ignorar completamente
const IGNORAR = [];

// Prefijos de país a bloquear (+57 Colombia — extorsión)
const IGNORAR_PREFIJOS = ["+57"];

// ── Planilla: Sheet ID para gastos/ingresos ───────────────────────────────────
// Si tenés un sheet específico para esto, ponelo en la variable PLANILLA_SHEET_ID
// Por ahora se loguea y se notifica a supervisores
const PLANILLA_SHEET_ID = process.env.PLANILLA_GASTOS_SHEET_ID || null;

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────
async function handleMessage(from, text, messageId, mediaIds = null) {
  if (messageId) markRead(messageId).catch(() => {});

  const normalized = (text || "").trim();
  const session    = get(from);
  const fromE164   = from.startsWith("+") ? from : `+${from}`;

  // ── Comandos especiales ───────────────────────────────────────────────────
  if (normalized === "/reset") {
    reset(from);
    await sendText(from, "🔄 Reiniciado.");
    return;
  }

  if (IGNORAR.includes(fromE164) || IGNORAR.includes(from)) return;
  if (IGNORAR_PREFIJOS.some(p => fromE164.startsWith(p) || from.startsWith(p))) {
    console.log(`🚫 Bloqueado: ${from}`);
    return;
  }

  const esSupervisor = SUPERVISORES.includes(fromE164) || SUPERVISORES.includes(from);

  // ── MODO SOLICITANTE DE TRABAJO ───────────────────────────────────────────
  if (session.modo === "solicitante") {
    await handleRRHHFlow(from, normalized, session, "solicitante");
    return;
  }

  // ── MODO PROVEEDOR ────────────────────────────────────────────────────────
  if (session.modo === "proveedor") {
    await handleRRHHFlow(from, normalized, session, "proveedor");
    return;
  }

  if (session.escalated && !esSupervisor) return;

  try {
    // ── Descargar imágenes ────────────────────────────────────────────────
    let imageDataArray = [];
    if (mediaIds) {
      const ids = Array.isArray(mediaIds) ? mediaIds : [mediaIds];
      console.log(`🖼️ Descargando ${ids.length} imagen(es) de ${from}...`);
      const results = await Promise.allSettled(ids.map(id => downloadMedia(id)));
      imageDataArray = results
        .map((r, i) => {
          if (r.status === "fulfilled" && r.value) {
            console.log(`✅ Imagen ${i+1}/${ids.length} (${r.value.mimeType})`);
            return r.value;
          }
          console.error(`❌ Error img ${i+1}:`, r.reason?.message);
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

    // ── Memoria (solo clientes, no supervisores) ──────────────────────────
    if (!esSupervisor) {
      const clientName = session.name || null;
      if (normalized) {
        memoria.guardarMensaje({ phone: fromE164, clientName, direction: "in", type: "text", content: normalized, session }).catch(() => {});
      }
      if (imageDataArray.length > 0) {
        const ids = Array.isArray(mediaIds) ? mediaIds : [mediaIds];
        imageDataArray.forEach((imgData, i) => {
          const mediaId = ids[i] || "";
          memoria.guardarMedia(imgData.base64, imgData.mimeType, fromE164, clientName)
            .then(driveUrl => memoria.guardarMensaje({ phone: fromE164, clientName, direction: "in", type: "image", content: "[Foto enviada por el cliente]", mediaId, driveUrl: driveUrl || "", session }).catch(() => {}))
            .catch(() => memoria.guardarMensaje({ phone: fromE164, clientName, direction: "in", type: "image", content: "[Foto enviada por el cliente]", mediaId, driveUrl: "", session }).catch(() => {}));
        });
      }
    }

    // ── Para supervisores: primero intentar consulta de memoria ──────────
    // Si es una consulta de resumen/historial → respondemos de memoria y seguimos
    // Si NO → continuamos al flujo completo de Claude (ya no salimos temprano)
    if (esSupervisor && normalized) {
      // Verificar si es una consulta de resumen de cliente por memoria directa
      const esConsultaResumen = /resumen|historial|conv[ea]rsaci[oó]n|qué me dijo|qu[eé] habl[oó]|cliente.*número|número.*cliente/i.test(normalized);
      if (esConsultaResumen) {
        const respuestaMemoria = await memoria.procesarConsultaMemoria(normalized);
        if (respuestaMemoria) {
          await sendText(from, respuestaMemoria);
          addMsg(from, "assistant", respuestaMemoria);
          return;
        }
      }
      // Si no es consulta de memoria, continúa al flujo de Claude con contexto de supervisor
    }

    // ── Detectar día/fecha para disponibilidad ────────────────────────────
    const dayMentioned = detectDayOrDate(normalized);
    let availabilityContext = "";

    if (dayMentioned && dayMentioned !== session.slots_shown) {
      const slots = await getAvailableSlots(dayMentioned);
      update(from, { slots_shown: dayMentioned });

      if (slots.length === 0) {
        availabilityContext = `\n\n[SISTEMA: El ${esSupervisor ? "supervisor" : "cliente"} pidió ${dayMentioned} pero NO hay slots disponibles. Explicale y ofrecé los días disponibles: lunes, martes o viernes.]`;
      } else {
        const slotsText = slots.map(s => {
          const [h, m] = s.split(":");
          const hNum = parseInt(h);
          const h12  = hNum > 12 ? hNum - 12 : hNum;
          return `${h12}:${m} ${hNum >= 12 ? "p.m." : "a.m."}`;
        }).join(", ");
        availabilityContext = `\n\n[SISTEMA: Slots disponibles para ${dayMentioned}: ${slotsText}. Ofrece SOLO estos horarios. La disponibilidad ya fue verificada — NO digas que vas a verificarla.]`;
      }
    }

    // ── Llamar a Claude ───────────────────────────────────────────────────
    const rawResponse = await ask(session.history.slice(0, -1), normalized + availabilityContext, imageData);
    const { cleanMessage, flag, flagData } = parseFlags(rawResponse);

    await sendText(from, cleanMessage);
    addMsg(from, "assistant", cleanMessage);

    if (!esSupervisor) {
      memoria.guardarMensaje({ phone: fromE164, clientName: session.name || null, direction: "out", type: "text", content: cleanMessage, session }).catch(() => {});
    }

    // ── Monitor supervisores (solo para conversaciones de clientes) ───────
    if (!esSupervisor) {
      const clientLabel    = session.name ? `${session.name} (${from})` : from;
      const clientMsgLabel = imageDataArray.length > 0
        ? `📷 [${imageDataArray.length} foto(s)]${normalized ? ` "${normalized}"` : ""}`
        : normalized;
      const monitorMsg = `👁️ *Conversación en tiempo real*\n👤 Cliente: ${clientLabel}\n\n💬 *Cliente:* ${clientMsgLabel}\n🤖 *Sasha:* ${cleanMessage}`;
      for (const supervisor of SUPERVISORES) {
        sendText(supervisor, monitorMsg).catch(err => console.error(`❌ Monitor [${supervisor}]: ${err.message}`));
      }
      if (mediaIds) {
        const ids = Array.isArray(mediaIds) ? mediaIds : [mediaIds];
        for (const mediaId of ids) {
          for (const supervisor of SUPERVISORES) {
            sendMediaById(supervisor, mediaId, "image", `📷 Foto de cliente: ${clientLabel}`).catch(() => {});
          }
        }
      }
    }

    // ── Procesar flags ────────────────────────────────────────────────────
    if (flag === "ESCALAR") {
      update(from, { escalated: true });
      if (!esSupervisor) {
        await sendText(from, `📞 Le conecto ahora con *${KNOWLEDGE.empresa.encargado}* de nuestro equipo.`);
        await notifyAllSupervisors(from, session, normalized, "escalacion");
      }

    } else if (flag === "LEAD") {
      const [name, project, zone] = (flagData || "").split("|");
      const updated = update(from, {
        name:         name?.trim()    || session.name,
        project_desc: project?.trim() || session.project_desc,
        zone:         zone?.trim()    || session.zone,
      });
      if (!session.lead_saved) {
        update(from, { lead_saved: true });
        logLead(from, updated);
        upsertLead({ ...updated, phone: from }).catch(() => {});
      }

    } else if (flag === "VISITA") {
      // ── Agendamiento: funciona tanto desde cliente como desde supervisor ──
      const [name, project, zone, day, hour, ubicacion, email] = (flagData || "").split("|");

      // Si es supervisor agendando por un cliente, el teléfono "from" es el del supervisor
      // Sasha debe incluir el teléfono del cliente en el flag cuando viene de supervisor
      // Formato extendido: [VISITA:nombre|proyecto|zona|dia|hora|ubicacion|email|telefono_cliente]
      const parts = (flagData || "").split("|");
      const telefonoCliente = parts[7]?.trim() || (esSupervisor ? null : from);
      const targetPhone     = telefonoCliente || from;

      const updated = update(targetPhone, {
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

      const visitHour = updated.visit_hour || "09:00";
      const [hh, mm]  = visitHour.split(":");
      const hourNum   = parseInt(hh);
      const hour12    = hourNum > 12 ? hourNum - 12 : hourNum === 0 ? 12 : hourNum;
      const timeStr   = `${hour12}:${mm} ${hourNum >= 12 ? "p.m." : "a.m."}`;
      let   dateStr   = updated.visit_day;

      try {
        const eventData = await createVisitEvent({
          name:        updated.name,
          phone:       targetPhone,
          project:     updated.project_desc,
          zone:        updated.zone,
          day:         updated.visit_day,
          hour:        updated.visit_hour,
          wazeLink:    updated.waze_link,
          clientEmail: updated.client_email,
        });
        dateStr = eventData.startDate.toLocaleDateString("es-CR", {
          weekday: "long", day: "numeric", month: "long",
          timeZone: "America/Costa_Rica",
        });
        console.log(`📅 Visita agendada: ${eventData.eventLink}${eventData.rescheduled ? " (reagendada)" : ""}`);
      } catch (calErr) {
        console.error("❌ Error Calendar:", calErr.message);
      }

      try {
        await sendVisitConfirmation({
          name: updated.name, phone: targetPhone, project: updated.project_desc,
          zone: updated.zone, day: updated.visit_day, hour: updated.visit_hour,
          wazeLink: updated.waze_link, clientEmail: updated.client_email,
          dateStr, timeStr,
        });
      } catch (emailErr) {
        console.error("❌ Error email:", emailErr.message);
      }

      registerVisit({ ...updated, phone: targetPhone }).catch(() => {});
      upsertLead({ ...updated, phone: targetPhone }).catch(() => {});

      // Notificar a supervisores
      await notifyAllSupervisors(targetPhone, updated, normalized, "visita_solicitada");
      logLead(targetPhone, updated, "visita_solicitada");

      // Confirmación al cliente (si viene de supervisor, enviar también al cliente si tiene teléfono)
      if (!esSupervisor) {
        await sendText(from, `✅ ¡Listo! Su cita quedó agendada para el *${dateStr} a las ${timeStr}*. Le llegará una confirmación por correo 📅`);
      } else if (telefonoCliente) {
        // Si el supervisor dio el número del cliente, confirmarle directamente
        const msgCliente = `¡Hola ${updated.name || ""}! 👋 Soy *Sasha* de *SS Remodelaciones*. Su visita técnica quedó confirmada para el *${dateStr} a las ${timeStr}*. Nuestro equipo estará puntual. ¿Alguna duda? Con gusto le ayudo 😊`;
        sendText(telefonoCliente.startsWith("+") ? telefonoCliente : "+" + telefonoCliente, msgCliente).catch(e => console.warn("⚠️ No se pudo notificar al cliente:", e.message));
      }

    } else if (flag === "SOLICITANTE") {
      update(from, { modo: "solicitante", rrhh_paso: 0, rrhh_data: {} });
      const msg = `Gracias por su interés en trabajar con *SS Remodelaciones* 👷\n\nPara registrar su información en Recursos Humanos, le haré unas preguntas. Le estaremos llamando cuando tengamos nuevos proyectos disponibles.\n\n${PASOS_SOLICITANTE[0].pregunta}`;
      await sendText(from, msg);
      addMsg(from, "assistant", msg);

    } else if (flag === "PROVEEDOR") {
      update(from, { modo: "proveedor", rrhh_paso: 0, rrhh_data: {} });
      const msg = `Gracias por contactarnos 🏗️\n\nPara registrar su empresa en nuestra base de proveedores de *SS Remodelaciones*, le haré unas preguntas breves.\n\n${PASOS_PROVEEDOR[0].pregunta}`;
      await sendText(from, msg);
      addMsg(from, "assistant", msg);

    } else if (flag === "GASTO") {
      // ── Registrar gasto en planilla ───────────────────────────────────────
      // Formato: [GASTO:proyecto|descripcion|monto|fecha]
      const [proyecto, descripcion, monto, fecha] = (flagData || "").split("|");
      await registrarMovimientoPlanilla({
        tipo: "GASTO",
        proyecto: proyecto?.trim() || "General",
        descripcion: descripcion?.trim() || "Gasto sin descripción",
        monto: monto?.trim() || "0",
        fecha: fecha?.trim() || new Date().toLocaleDateString("es-CR", { timeZone: "America/Costa_Rica" }),
        registradoPor: from,
      });
      console.log(`💸 Gasto registrado: ${proyecto} — ${descripcion} — ₡${monto}`);

    } else if (flag === "INGRESO") {
      // ── Registrar ingreso en planilla ─────────────────────────────────────
      // Formato: [INGRESO:proyecto|descripcion|monto|fecha]
      const [proyecto, descripcion, monto, fecha] = (flagData || "").split("|");
      await registrarMovimientoPlanilla({
        tipo: "INGRESO",
        proyecto: proyecto?.trim() || "General",
        descripcion: descripcion?.trim() || "Ingreso sin descripción",
        monto: monto?.trim() || "0",
        fecha: fecha?.trim() || new Date().toLocaleDateString("es-CR", { timeZone: "America/Costa_Rica" }),
        registradoPor: from,
      });
      console.log(`💰 Ingreso registrado: ${proyecto} — ${descripcion} — ₡${monto}`);

    } else if (flag === "MSG_CLIENTE") {
      // ── Enviar mensaje a cliente por instrucción del supervisor ───────────
      // Formato: [MSG_CLIENTE:telefono|mensaje]
      const idx          = (flagData || "").indexOf("|");
      const telefonoDest = idx > -1 ? flagData.slice(0, idx).trim() : "";
      const mensajeDest  = idx > -1 ? flagData.slice(idx + 1).trim() : "";
      if (telefonoDest && mensajeDest) {
        const destE164 = telefonoDest.startsWith("+") ? telefonoDest : "+" + telefonoDest;
        try {
          await sendText(destE164, mensajeDest);
          console.log(`📤 Mensaje enviado a cliente ${destE164} por instrucción de supervisor ${from}`);
        } catch (e) {
          console.error("❌ Error enviando mensaje a cliente:", e.message);
          await sendText(from, `⚠️ No pude enviar el mensaje a ${destE164}: ${e.message}`);
        }
      }

    } else if (flag === "RESUMEN_CLIENTE") {
      // ── Traer resumen de conversación de un cliente ───────────────────────
      // Formato: [RESUMEN_CLIENTE:telefono_o_nombre]
      const query = (flagData || "").trim();
      if (query) {
        const resumen = await memoria.procesarConsultaMemoria(`resumen del cliente ${query}`);
        if (resumen) {
          await sendText(from, resumen);
        } else {
          await sendText(from, `⚠️ No encontré conversaciones registradas para "${query}". Asegurate de usar el número completo con código de país (ej: +50688888888) o el nombre exacto.`);
        }
      }
    }

  } catch (err) {
    console.error("❌ Error en handleMessage:", err.message, err.stack);
    const errorMsg = esSupervisor
      ? `⚠️ Error procesando la instrucción: ${err.message}`
      : `Tuve un problema técnico 😔 Por favor escríbale directamente a *${KNOWLEDGE.empresa.encargado}* al ${KNOWLEDGE.empresa.whatsapp_melvin}.`;
    await sendText(from, errorMsg).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRO DE MOVIMIENTO EN PLANILLA (Gastos / Ingresos)
// ─────────────────────────────────────────────────────────────────────────────
async function registrarMovimientoPlanilla({ tipo, proyecto, descripcion, monto, fecha, registradoPor }) {
  const montoNum = parseFloat(String(monto).replace(/[^0-9.]/g, "")) || 0;

  // Log siempre para tener trazabilidad
  console.log(`📊 PLANILLA [${tipo}] — Proyecto: ${proyecto} | ${descripcion} | ₡${montoNum.toLocaleString()} | ${fecha} | por: ${registradoPor}`);

  // Si hay un Sheet ID configurado, guardar ahí
  if (PLANILLA_SHEET_ID) {
    try {
      const { google } = require("googleapis");
      const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
      const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
      const sheets = google.sheets({ version: "v4", auth });

      await sheets.spreadsheets.values.append({
        spreadsheetId: PLANILLA_SHEET_ID,
        range: `${tipo === "GASTO" ? "GASTOS" : "INGRESOS"}!A:F`,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        resource: {
          values: [[
            fecha,
            proyecto,
            descripcion,
            montoNum,
            registradoPor,
            new Date().toISOString(),
          ]],
        },
      });
      console.log(`✅ Planilla: ${tipo} guardado en Sheets`);
    } catch (err) {
      console.error(`❌ Error guardando en planilla:`, err.message);
      // Notificar al supervisor que registró, para que lo apunte manualmente
      const { sendText: st } = require("./messenger");
      st(registradoPor, `⚠️ El ${tipo.toLowerCase()} se registró localmente pero no pudo guardarse en el Sheet. Por favor registralo manualmente:\n\n📅 ${fecha}\n📁 ${proyecto}\n📝 ${descripcion}\n💰 ₡${montoNum.toLocaleString()}`).catch(() => {});
    }
  }

  // Notificar a todos los supervisores del registro
  const { sendText: st } = require("./messenger");
  const emoji = tipo === "GASTO" ? "💸" : "💰";
  const notif = `${emoji} *${tipo} registrado*\n\n📁 Proyecto: ${proyecto}\n📝 ${descripcion}\n💵 ₡${montoNum.toLocaleString()}\n📅 ${fecha}\n👤 Registrado por: ${registradoPor}`;

  for (const sup of SUPERVISORES) {
    if (sup !== registradoPor) {
      st(sup, notif).catch(() => {});
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function parseFlags(response) {
  // Flags soportados: ESCALAR, LEAD, VISITA, SOLICITANTE, PROVEEDOR, GASTO, INGRESO, MSG_CLIENTE, RESUMEN_CLIENTE
  const flagRegex    = /\[(ESCALAR|LEAD:([^\]]*)|VISITA:([^\]]*)|SOLICITANTE|PROVEEDOR|GASTO:([^\]]*)|INGRESO:([^\]]*)|MSG_CLIENTE:([^\]]*)|RESUMEN_CLIENTE:([^\]]*))\]\s*$/;
  const sistemaRegex = /\[SISTEMA:[\s\S]*?\]/g;
  const match        = response.match(flagRegex);

  if (!match) return { cleanMessage: response.replace(sistemaRegex, "").trim(), flag: null, flagData: null };

  const cleanMessage = response.replace(flagRegex, "").replace(sistemaRegex, "").trim();
  const fullFlag     = match[1];

  if (fullFlag === "ESCALAR")     return { cleanMessage, flag: "ESCALAR",         flagData: null };
  if (fullFlag === "SOLICITANTE") return { cleanMessage, flag: "SOLICITANTE",     flagData: null };
  if (fullFlag === "PROVEEDOR")   return { cleanMessage, flag: "PROVEEDOR",       flagData: null };
  if (fullFlag.startsWith("LEAD:"))            return { cleanMessage, flag: "LEAD",            flagData: fullFlag.slice(5) };
  if (fullFlag.startsWith("VISITA:"))          return { cleanMessage, flag: "VISITA",          flagData: fullFlag.slice(7) };
  if (fullFlag.startsWith("GASTO:"))           return { cleanMessage, flag: "GASTO",           flagData: fullFlag.slice(6) };
  if (fullFlag.startsWith("INGRESO:"))         return { cleanMessage, flag: "INGRESO",         flagData: fullFlag.slice(8) };
  if (fullFlag.startsWith("MSG_CLIENTE:"))     return { cleanMessage, flag: "MSG_CLIENTE",     flagData: fullFlag.slice(12) };
  if (fullFlag.startsWith("RESUMEN_CLIENTE:")) return { cleanMessage, flag: "RESUMEN_CLIENTE", flagData: fullFlag.slice(16) };

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

// Detecta día de la semana O fecha específica en el texto
function detectDayOrDate(text) {
  const n = (text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  if (n.includes("lunes"))   return "lunes";
  if (n.includes("martes"))  return "martes";
  if (n.includes("viernes")) return "viernes";

  const MONTHS = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto",
                  "septiembre","octubre","noviembre","diciembre"];
  for (const mes of MONTHS) {
    const re = new RegExp(`(\\d{1,2})\\s+(?:de\\s+)?${mes}`, "i");
    const m  = n.match(re);
    if (m) return `${m[1]} de ${mes}`;
  }

  const m2 = n.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (m2) return `${m2[1]}/${m2[2]}`;

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// FLUJO RRHH / PROVEEDORES
// ─────────────────────────────────────────────────────────────────────────────
async function handleRRHHFlow(from, text, session, tipo) {
  const pasos = tipo === "solicitante" ? PASOS_SOLICITANTE : PASOS_PROVEEDOR;
  const paso  = session.rrhh_paso || 0;
  const data  = { ...(session.rrhh_data || {}) };

  if (pasos[paso]?.campo && text) {
    data[pasos[paso].campo] = text;
    update(from, { rrhh_data: data });
  }

  const siguientePaso = paso + 1;

  if (siguientePaso < pasos.length) {
    update(from, { rrhh_paso: siguientePaso });
    const msg = pasos[siguientePaso].pregunta;
    await sendText(from, msg);
    addMsg(from, "assistant", msg);
    return;
  }

  // Todos los datos recolectados
  update(from, { modo: null, rrhh_paso: 0, rrhh_data: {} });

  if (tipo === "solicitante") {
    await guardarSolicitante({
      phone: from, nombre: data.nombre, cedula: data.cedula,
      telefono: data.telefono, direccion: data.direccion,
      habilidad: data.habilidad, curriculum: data.curriculum,
    });
    const msg = `✅ Listo, registré su información con éxito.\n\nRecuerde que al ser contactado/a deberá presentar su *hoja de delincuencia* actualizada.\n\nLe estaremos llamando cuando tengamos proyectos disponibles. ¡Gracias por su interés en SS Remodelaciones! 🙌`;
    await sendText(from, msg);
    for (const sup of SUPERVISORES) {
      sendText(sup, `👷 *Nuevo solicitante*\n\n📱 ${from}\n👤 ${data.nombre||"—"}\n🪪 ${data.cedula||"—"}\n📞 ${data.telefono||"—"}\n📍 ${data.direccion||"—"}\n🔧 ${data.habilidad||"—"}\n\n_Sasha — Bot SSR_`).catch(() => {});
    }
  } else {
    await guardarProveedor({
      phone: from, empresa: data.empresa, contacto: data.contacto,
      email: data.email, telefono: data.telefono, sector: data.sector,
    });
    const msg = `✅ ¡Perfecto! Registramos la información de *${data.empresa||"su empresa"}* en nuestra base de proveedores.\n\nCuando tengamos necesidades en su área, los contactaremos. ¡Gracias! 🏗️`;
    await sendText(from, msg);
    for (const sup of SUPERVISORES) {
      sendText(sup, `🏭 *Nuevo proveedor*\n\n📱 ${from}\n🏢 ${data.empresa||"—"}\n👤 ${data.contacto||"—"}\n📧 ${data.email||"—"}\n🏗️ ${data.sector||"—"}\n\n_Sasha — Bot SSR_`).catch(() => {});
    }
  }
}

module.exports = { handleMessage };
