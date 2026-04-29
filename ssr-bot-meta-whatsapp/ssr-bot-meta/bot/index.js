const { get, update, addMsg, reset } = require("./state");
const { ask } = require("./claude");
const { sendText, markRead } = require("./messenger");
const { createVisitEvent, getAvailableSlots } = require("./calendar");
const { sendVisitConfirmation } = require("./email");
const KNOWLEDGE = require("./knowledge");

async function handleMessage(from, text, messageId) {
  if (messageId) markRead(messageId).catch(() => {});

  const normalized = text.trim();
  const session = get(from);

  if (normalized === "/reset") {
    reset(from);
    await sendText(from, "🔄 Reiniciado.");
    return;
  }

  if (session.escalated) return;

  try {
    addMsg(from, "user", normalized);

    // Detectar si el cliente mencionó un día para consultar disponibilidad
    const dayMentioned = detectDay(normalized);
    let availabilityContext = "";

    if (dayMentioned && !session.slots_shown) {
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
        availabilityContext = `\n\n[SISTEMA: Slots disponibles para ${dayMentioned}: ${slotsText}. Ofrecé SOLO estos horarios al cliente, no otros.]`;
      }
    }

    const rawResponse = await ask(session.history.slice(0, -1), normalized + availabilityContext);
    const { cleanMessage, flag, flagData } = parseFlags(rawResponse);

    await sendText(from, cleanMessage);
    addMsg(from, "assistant", cleanMessage);

    // Reset slots_shown si cambia de día
    if (dayMentioned && dayMentioned !== session.slots_shown) {
      update(from, { slots_shown: null });
    }

    if (flag === "ESCALAR") {
      update(from, { escalated: true });
      await sendText(from, `📲 Te conecto ahora con *${KNOWLEDGE.empresa.encargado}* de nuestro equipo.`);
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
        console.log(`📅 Visita agendada en Calendar: ${eventData.eventLink}`);
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

      await notifyMelvin(from, updated, normalized, "visita_solicitada");
      logLead(from, updated, "visita_solicitada");

      await sendText(from, `✅ ¡Listo! Tu cita quedó agendada para el *${dateStr} a las ${timeStr}*. Te llegará una confirmación por correo y un recordatorio el día anterior 📧`);
    }

  } catch (err) {
    console.error("❌ Error:", err.message);
    await sendText(from,
      `Tuve un problema técnico 😔 Escribile directamente a *${KNOWLEDGE.empresa.encargado}* al ${KNOWLEDGE.empresa.whatsapp_melvin}.`
    );
  }
}

function detectDay(text) {
  const normalized = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (normalized.includes("lunes")) return "lunes";
  if (normalized.includes("martes")) return "martes";
  if (normalized.includes("viernes")) return "viernes";
  return null;
}

function parseFlags(response) {
  const flagRegex = /\[(ESCALAR|LEAD:([^\]]*)|VISITA:([^\]]*))]\s*$/;
  const match = response.match(flagRegex);

  if (!match) return { cleanMessage: response.trim(), flag: null, flagData: null };

  const cleanMessage = response.replace(flagRegex, "").trim();
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
