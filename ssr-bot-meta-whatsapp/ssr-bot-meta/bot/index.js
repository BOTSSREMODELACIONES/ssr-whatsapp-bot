const { get, update, addMsg, reset } = require("./state");
const { ask }                        = require("./claude");
const { sendText, markRead, downloadMedia, sendMediaById } = require("./messenger");
const { createVisitEvent, getAvailableSlots } = require("./calendar");
const { sendVisitConfirmation }      = require("./email");
const { upsertLead, registerVisit }  = require("./crm");
const KNOWLEDGE                      = require("./knowledge");
const memoria                        = require("./memoria");
const { guardarSolicitante, guardarProveedor, PASOS_SOLICITANTE, PASOS_PROVEEDOR } = require("./rrhh");

const SUPERVISORES = ["+50683091817", "+50671981370"];
const IGNORAR = [];

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

  // ── MODO SUPERVISOR ──────────────────────────────────────────────────────────
  const esSupervisor = SUPERVISORES.includes(fromE164) || SUPERVISORES.includes(from);
  if (esSupervisor && normalized) {
    const respuestaMemoria = await memoria.procesarConsultaMemoria(normalized);
    if (respuestaMemoria) {
      await sendText(from, respuestaMemoria);
      return;
    }
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

    // ── Memoria ───────────────────────────────────────────────────────────────
    if (!esSupervisor) {
      const clientName = session.name || null;
      if (normalized) {
        memoria.guardarMensaje({ phone: fromE164, clientName, direction: "in", type: "text", content: normalized, session }).catch(() => {});
      }
      if (imageDataArray.length > 0) {
        const ids = Array.isArray(mediaIds) ? mediaIds : [mediaIds];
        imageDataArray.forEach((imgData, i) => {
          const mediaId = ids[i] || "";
          memoria.guardarMedia(imgData.data, imgData.mimeType, fromE164, clientName)
            .then(driveUrl => memoria.guardarMensaje({ phone: fromE164, clientName, direction: "in", type: "image", content: "[Foto enviada por el cliente]", mediaId, driveUrl: driveUrl || "", session }).catch(() => {}))
            .catch(() => memoria.guardarMensaje({ phone: fromE164, clientName, direction: "in", type: "image", content: "[Foto enviada por el cliente]", mediaId, driveUrl: "", session }).catch(() => {}));
        });
      }
    }

    // ── NUEVO v4: Detectar día/fecha para disponibilidad ──────────────────────
    // Ahora maneja tanto "martes" como "19 de mayo", "19/05", etc.
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
          const hNum = parseInt(h);
          const h12  = hNum > 12 ? hNum - 12 : hNum;
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
    const clientLabel = session.name ? `${session.name} (${from})` : from;
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
          day:         updated.visit_day,    // ← ahora puede ser "19 de mayo" o "martes"
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
      const msg = `Gracias por su interés en trabajar con *SS Remodelaciones* 👷\n\nPara registrar su información en Recursos Humanos, le haré unas preguntas. Le estaremos llamando cuando tengamos nuevos proyectos disponibles.\n\n${PASOS_SOLICITANTE[0].pregunta}`;
      await sendText(from, msg);
      addMsg(from, "assistant", msg);

    } else if (flag === "PROVEEDOR") {
      update(from, { modo: "proveedor", rrhh_paso: 0, rrhh_data: {} });
      const msg = `Gracias por contactarnos 🏗️\n\nPara registrar su empresa en nuestra base de proveedores de *SS Remodelaciones*, le haré unas preguntas breves.\n\n${PASOS_PROVEEDOR[0].pregunta}`;
      await sendText(from, msg);
      addMsg(from, "assistant", msg);
    }

  } catch (err) {
    console.error("❌ Error:", err.message);
    await sendText(from, `Tuve un problema técnico 😔 Por favor escríbale directamente a *${KNOWLEDGE.empresa.encargado}* al ${KNOWLEDGE.empresa.whatsapp_melvin}.`);
  }
}

// ── Flujo de recolección RRHH / Proveedores ───────────────────────────────────
async function handleRRHHFlow(from, text, session, tipo) {
  const pasos = tipo === "solicitante" ? PASOS_SOLICITANTE : PASOS_PROVEEDOR;
  const paso  = session.rrhh_paso || 0;
  const data  = { ...(session.rrhh_data || {}) };

  // Guardar respuesta del paso actual
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

  // ── Todos los datos recolectados ──────────────────────────────────────────
  update(from, { modo: null, rrhh_paso: 0, rrhh_data: {} });

  if (tipo === "solicitante") {
    const ok = await guardarSolicitante({
      phone: from, nombre: data.nombre, cedula: data.cedula,
      telefono: data.telefono, direccion: data.direccion,
      habilidad: data.habilidad, curriculum: data.curriculum,
    });
    const msg = `✅ Listo, registré su información con éxito.\n\nRecuerde que al ser contactado/a deberá presentar su *hoja de delincuencia* actualizada.\n\nLe estaremos llamando cuando tengamos proyectos disponibles. ¡Gracias por su interés en SS Remodelaciones! 🙌`;
    await sendText(from, msg);

    for (const sup of SUPERVISORES) {
      sendText(sup, `👷 *Nuevo solicitante de trabajo*\n\n📱 ${from}\n👤 ${data.nombre||"—"}\n🪪 Cédula: ${data.cedula||"—"}\n📞 ${data.telefono||"—"}\n📍 ${data.direccion||"—"}\n🔧 ${data.habilidad||"—"}\n📋 ${data.curriculum||"—"}\n\n_Sasha — Bot SSR_`).catch(() => {});
    }

  } else {
    const ok = await guardarProveedor({
      phone: from, empresa: data.empresa, contacto: data.contacto,
      email: data.email, telefono: data.telefono, sector: data.sector,
    });
    const msg = `✅ ¡Perfecto! Registramos la información de *${data.empresa||"su empresa"}* en nuestra base de proveedores.\n\nCuando tengamos necesidades en su área, los contactaremos. ¡Gracias! 🏗️`;
    await sendText(from, msg);

    for (const sup of SUPERVISORES) {
      sendText(sup, `🏭 *Nuevo proveedor registrado*\n\n📱 ${from}\n🏢 ${data.empresa||"—"}\n👤 ${data.contacto||"—"}\n📧 ${data.email||"—"}\n📞 ${data.telefono||"—"}\n🏗️ ${data.sector||"—"}\n\n_Sasha — Bot SSR_`).catch(() => {});
    }
  }
}

// ── NUEVO: detectar nombre de día O fecha específica ─────────────────────────
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
