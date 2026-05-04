const { get, update, addMsg, reset } = require("./state");
const { ask } = require("./claude");
const { sendText, markRead, downloadMedia } = require("./messenger");
const { createVisitEvent, getAvailableSlots } = require("./calendar");
const { sendVisitConfirmation } = require("./email");
const { upsertLead, registerVisit } = require("./crm");
const KNOWLEDGE = require("./knowledge");

// Números que reciben copia de cada conversación en tiempo real
const SUPERVISORES = ["+50683091817", "+50671981370"];

// Números que el bot debe ignorar completamente
const IGNORAR = [];

// mediaIds puede ser: null | string | string[]
async function handleMessage(from, text, messageId, mediaIds = null) {
  if (messageId) markRead(messageId).catch(() => {});

  const normalized = (text || "").trim();
  const session = get(from);

  if (normalized === "/reset") {
    reset(from);
    await sendText(from, "🔄 Reiniciado.");
    return;
  }

  if (IGNORAR.includes(`+${from}`) || IGNORAR.includes(from)) return;
  if (session.escalated) return;

  try {
    // ── Descargar todas las imágenes en paralelo ───────────────────────────
    let imageDataArray = [];

    if (mediaIds) {
      const ids = Array.isArray(mediaIds) ? mediaIds : [mediaIds];
      console.log(`🖼️ Descargando ${ids.length} imagen(es) de +${from}...`);

      const results = await Promise.allSettled(ids.map(id => downloadMedia(id)));

      imageDataArray = results
        .map((r, i) => {
          if (r.status === "fulfilled" && r.value) {
            console.log(`✅ Imagen ${i + 1}/${ids.length} descargada (${r.value.mimeType})`);
            return r.value;
          } else {
            console.error(`❌ Error descargando imagen ${i + 1}/${ids.length}:`, r.reason?.message);
            return null;
          }
        })
        .filter(Boolean);
    }

    // imageData que se pasa a ask(): null | objeto | array
    const imageData = imageDataArray.length === 0 ? null
      : imageDataArray.length === 1 ? imageDataArray[0]
      : imageDataArray;

    if (!normalized && imageDataArray.length === 0) return;

    // Texto de historial: describe cuántas fotos si las hay
    const historyText = normalized ||
      (imageDataArray.length === 1
        ? "[Cliente envió una foto]"
        : `[Cliente envió ${imageDataArray.length} fotos]`);

    addMsg(from, "user", historyText);

    // ── Detectar día para disponibilidad ──────────────────────────────────
    const dayMentioned = detectDay(normalized);
    let availabilityContext = "";

    if (dayMentioned && dayMentioned !== session.slots_shown) {
      const slots = await getAvailableSlots(dayMentioned);
      update(from, { slots_shown: dayMentioned });

      if (slots.length === 0) {
        availabilityContext = `\n\n[SISTEMA: El cliente pidió ${dayMentioned} pero NO hay slots disponibles ese día. Explicale amablemente y ofrecele los otros días disponibles: lunes, martes o viernes.]`;
      } else {
        const slotsText = slots.map(s => {
          const [h, m] = s.split(":");
          const hNum = parseInt(h);
          const ampm = hNum >= 12 ? "p.m." : "a.m.";
          const h12 = hNum > 12 ? hNum - 12 : hNum;
          return `${h12}:${m} ${ampm}`;
        }).join(", ");
        availabilityContext = `\n\n[SISTEMA: Slots disponibles para ${dayMentioned}: ${slotsText}. Ofrecé SOLO estos horarios al cliente. La disponibilidad ya fue verificada — NO digas que vas a confirmar disponibilidad ni que necesitás verificarla. Si el cliente ya eligió uno de estos horarios, procedé INMEDIATAMENTE al siguiente paso: pedirle la ubicación.]`;
      }
    }

    // ── Llamar a Claude ────────────────────────────────────────────────────
    const rawResponse = await ask(
      session.history.slice(0, -1),
      normalized + availabilityContext,
      imageData
    );
    const { cleanMessage, flag, flagData } = parseFlags(rawResponse);

    await sendText(from, cleanMessage);
    addMsg(from, "assistant", cleanMessage);

    // ── Monitor supervisores ───────────────────────────────────────────────
    const clientName = session.name ? `${session.name} (${from})` : from;
    const clientMsg = imageDataArray.length > 0
      ? `📷 [${imageDataArray.length} foto(s)]${normalized ? ` "${normalized}"` : ""}`
      : normalized;
    const monitorMsg = `👁️ *Conversación en tiempo real*\n👤 Cliente: ${clientName}\n\n💬 *Cliente:* ${clientMsg}\n🤖 *Sasha:* ${cleanMessage}`;
    for (const supervisor of SUPERVISORES) {
      sendText(supervisor, monitorMsg).catch(() => {});
    }

    // ── Procesar flags ─────────────────────────────────────────────────────
    if (flag === "ESCALAR") {
      update(from, { escalated: true });
      await sendText(from, `📲 Le conecto ahora con *${KNOWLEDGE.empresa.encargado}* de nuestro equipo.`);
      await notifyMelvin(from, session, normalized, "escalacion");

    } else if (flag === "LEAD") {
      const [name, project, zone] = (flagData || "").split("|");
      const updated = update(from, {
        name: name?.trim() || session.name,
        project_desc: project?.trim() || session.project_desc,
        zone: zone?.trim() || session.zone,
      });
      if (!session.lead_saved) {
        update(from, { lead_saved: true });
        logLead(from, updated);
        upsertLead({ ...updated, phone: from }).catch(() => {});
      }

    } else if (flag === "VISITA") {
      const [name, project, zone, day, hour, ubicacion, email] = (flagData || "").split("|");
      const updated = update(from, {
        name: name?.trim() || session.name,
        project_desc: project?.trim() || session.project_desc,
        zone: zone?.trim() || session.zone,
        visit_day: day?.trim() || "a coordinar",
        visit_hour: hour?.trim() || "09:00",
        waze_link: ubicacion?.trim() || "",
        client_email: email?.trim() || "",
        visit_confirmed: true,
        lead_saved: true,
      });

      const visitHour = updated.visit_hour || "09:00";
      const [hh, mm] = visitHour.split(":");
      const hourNum = parseInt(hh);
      const ampm = hourNum >= 12 ? "p.m." : "a.m.";
      const hour12 = hourNum > 12 ? hourNum - 12 : hourNum === 0 ? 12 : hourNum;
      let timeStr = `${hour12}:${mm} ${ampm}`;
      let dateStr = updated.visit_day;

      try {
        const eventData = await createVisitEvent({
          name: updated.name,
          phone: from,
          project: updated.project_desc,
          zone: updated.zone,
          day: updated.visit_day,
          hour: updated.visit_hour,
          wazeLink: updated.waze_link,
          clientEmail: updated.client_email,
        });

        dateStr = eventData.startDate.toLocaleDateString("es-CR", {
          weekday: "long", day: "numeric", month: "long",
          timeZone: "America/Costa_Rica",
        });
        console.log(`📅 Visita agendada en Calendar: ${eventData.eventLink}${eventData.rescheduled ? " (reagendada)" : ""}`);
      } catch (calErr) {
        console.error("❌ Error creando evento en Calendar:", calErr.message);
      }

      try {
        await sendVisitConfirmation({
          name: updated.name,
          phone: from,
          project: updated.project_desc,
          zone: updated.zone,
          day: updated.visit_day,
          hour: updated.visit_hour,
          wazeLink: updated.waze_link,
          clientEmail: updated.client_email,
          dateStr,
          timeStr,
        });
      } catch (emailErr) {
        console.error("❌ Error enviando email:", emailErr.message);
      }

      registerVisit({ ...updated, phone: from }).catch(() => {});
      await notifyMelvin(from, updated, normalized, "visita_solicitada");
      logLead(from, updated, "visita_solicitada");

      await sendText(from, `✅ ¡Listo! Su cita quedó agendada para el *${dateStr} a las ${timeStr}*. Le llegará una confirmación por correo y un recordatorio el día anterior 📧`);
    }

  } catch (err) {
    console.error("❌ Error:", err.message);
    await sendText(from,
      `Tuve un problema técnico 😔 Por favor escríbale directamente a *${KNOWLEDGE.empresa.encargado}* al ${KNOWLEDGE.empresa.whatsapp_melvin}.`
    );
  }
}

function detectDay(text) {
  const normalized = (text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (normalized.includes("lunes")) return "lunes";
  if (normalized.includes("martes")) return "martes";
  if (normalized.includes("viernes")) return "viernes";
  return null;
}

function parseFlags(response) {
  const flagRegex = /\[(ESCALAR|LEAD:([^\]]*)|VISITA:([^\]]*))]\s*$/;
  const sistemaRegex = /\[SISTEMA:[\s\S]*?\]/g;
  const match = response.match(flagRegex);

  if (!match) return { cleanMessage: response.replace(sistemaRegex, "").trim(), flag: null, flagData: null };

  const cleanMessage = response.replace(flagRegex, "").replace(sistemaRegex, "").trim();
  const fullFlag = match[1];

  if (fullFlag === "ESCALAR") return { cleanMessage, flag: "ESCALAR", flagData: null };
  if (fullFlag.startsWith("LEAD:")) return { cleanMessage, flag: "LEAD", flagData: fullFlag.slice(5) };
  if (fullFlag.startsWith("VISITA:")) return { cleanMessage, flag: "VISITA", flagData: fullFlag.slice(7) };

  return { cleanMessage, flag: null, flagData: null };
}

async function notifyMelvin(from, session, lastMsg, tipo) {
  const header = {
    visita_solicitada: "🗓️ NUEVA VISITA AGENDADA",
    escalacion: "🔔 CLIENTE NECESITA ATENCIÓN",
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

  try {
    await sendText(KNOWLEDGE.empresa.whatsapp_melvin, lines);
    console.log(`✅ Melvin notificado [${tipo}]`);
  } catch (err) {
    console.error("❌ Error notificando a Melvin:", err.message);
  }
}

function logLead(from, session, tipo = "lead") {
  console.log("📋 LEAD:", JSON.stringify({
    tipo, ts: new Date().toISOString(),
    phone: from,
    name: session.name || "—",
    project: session.project_desc || "—",
    zone: session.zone || "—",
    visit_day: session.visit_day || "—",
    visit_hour: session.visit_hour || "—",
    location: session.waze_link || "—",
    email: session.client_email || "—",
    visit: session.visit_confirmed || false,
  }));
}

module.exports = { handleMessage };
