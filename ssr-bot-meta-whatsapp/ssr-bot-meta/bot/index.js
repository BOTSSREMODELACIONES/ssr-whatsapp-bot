const { get, update, addMsg, reset } = require("./state");
const { ask }                        = require("./claude");
const { sendText, markRead, downloadMedia, sendMediaById } = require("./messenger");
const { createVisitEvent, getAvailableSlots, cancelEventByNameAndDate } = require("./calendar");
const { sendVisitConfirmation }      = require("./email");
const { upsertLead, registerVisit }  = require("./crm");
const KNOWLEDGE                      = require("./knowledge");
const memoria                        = require("./memoria");
const { guardarSolicitante, guardarProveedor, PASOS_SOLICITANTE, PASOS_PROVEEDOR } = require("./rrhh");

const SUPERVISORES = ["+50683091817", "+50671981370"];

// Números exactos a ignorar completamente
const IGNORAR = [];

// Prefijos de país a bloquear por seguridad
// +57 Colombia: números que buscan agendar visitas para extorsionar empleados
const IGNORAR_PREFIJOS = ["+57"];

// ─────────────────────────────────────────────────────────────────────────────
// detectarYCancelarCita
// Detecta si el mensaje del supervisor es una orden de cancelar una cita.
// Si lo es, ejecuta la cancelación y retorna el mensaje de respuesta (string).
// Si NO es una orden de cancelación, retorna null.
// ─────────────────────────────────────────────────────────────────────────────
async function detectarYCancelarCita(text) {
  const n = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Detectar intención de cancelar / borrar / eliminar cita / visita
  const esCancelacion = /\b(cancel|borr[ae]|elimin|quit)\w*\b/.test(n) &&
                        /\b(cita|visita|evento|reuni[on]|agend)\w*\b/.test(n);

  if (!esCancelacion) return null;

  // ── Extraer fecha ──────────────────────────────────────────────────────────
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

  // ── Extraer nombre del cliente ─────────────────────────────────────────────
  // Buscar después de "con", "de", "a"
  // Ej: "cancela la cita de mañana con Gabriela"
  //     "borra la visita de Roxana del viernes"
  let nameHint = null;

  const conMatch = text.match(/\bcon\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/i);
  const deMatch  = text.match(/\bde\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/i);
  const aMatch   = text.match(/\ba\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/i);

  if (conMatch) nameHint = conMatch[1].trim();
  else if (deMatch) nameHint = deMatch[1].trim();
  else if (aMatch)  nameHint = aMatch[1].trim();

  // Excluir palabras que no son nombres propios
  const EXCLUDE = ["manana", "mañana", "hoy", "la", "el", "los", "las", "una", "un",
                   "cita", "visita", "evento", "lunes", "martes", "miercoles",
                   "jueves", "viernes", "sabado", "domingo"];
  const nameNorm = (nameHint || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (nameHint && EXCLUDE.includes(nameNorm)) nameHint = null;

  console.log(`🗑️ Comando cancelación — nombre: "${nameHint || "—"}", fecha: "${dateHint || "—"}"`);

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

// ─────────────────────────────────────────────────────────────────────────────

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

  // Bloquear prefijos de países peligrosos (+57 Colombia - extorsión)
  if (IGNORAR_PREFIJOS.some(p => fromE164.startsWith(p) || from.startsWith(p))) {
    console.log(`🚫 Mensaje bloqueado de país restringido: ${from}`);
    return;
  }

  // ── MODO SUPERVISOR ──────────────────────────────────────────────────────────
  const esSupervisor = SUPERVISORES.includes(fromE164) || SUPERVISORES.includes(from);
  if (esSupervisor && normalized) {

    // 1. Comando de cancelación de cita (NUEVO)
    const cancelResult = await detectarYCancelarCita(normalized);
    if (cancelResult !== null) {
      await sendText(from, cancelResult);
      return;
    }

    // 2. Consulta de memoria (flujo existente)
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
      const msg = `Gracias por su interés en trabajar con *SS Remodelaciones* 👷\n\nPara registrar su información en Recursos Humanos, le haré unas preguntas.`;
      await sendText(from, msg);

    } else if (flag === "PROVEEDOR") {
      update(from, { modo: "proveedor", rrhh_paso: 0, rrhh_data: {} });
      const msg = `Gracias por su interés en ser proveedor de *SS Remodelaciones* 🏗️\n\nVoy a registrar los datos de su empresa.`;
      await sendText(from, msg);
    }

  } catch (err) {
    console.error("❌ Error en handleMessage:", err.message, err.stack);
  }
}

// ── RRHH Flow ─────────────────────────────────────────────────────────────────
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
        const nextPregunta = PASOS[nextPaso - 1];
        await sendText(from, nextPregunta.texto);
        return;
      }
    }
  }

  // Último paso — guardar
  const lastCampo = PASOS[PASOS.length - 1]?.campo;
  if (lastCampo && normalized) {
    data[lastCampo] = normalized;
    update(from, { rrhh_data: data });
  }

  if (tipo === "solicitante") {
    const ok = await guardarSolicitante({
      phone: from, nombre: data.nombre, cedula: data.cedula,
      telefono: data.telefono, direccion: data.direccion,
      habilidad: data.habilidad, curriculum: data.curriculum,
    });
    const msg = `✅ *¡Gracias ${data.nombre || ""}!*\n\nSu información quedó registrada en nuestro sistema de Recursos Humanos 📋\n\nCuando tengamos proyectos disponibles, lo contactaremos. ¡Mucho éxito! 🏗️\n\n_Sasha — Bot SS Remodelaciones_`;
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

// ── Detectar nombre de día O fecha específica ─────────────────────────────────
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
