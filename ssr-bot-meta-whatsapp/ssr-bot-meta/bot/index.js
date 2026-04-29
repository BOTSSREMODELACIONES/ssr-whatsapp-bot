const { get, update, addMsg, reset } = require("./state");
const { ask } = require("./claude");
const { sendText, markRead } = require("./messenger");
const { createVisitEvent } = require("./calendar");
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

    const rawResponse = await ask(session.history.slice(0, -1), normalized);
    const { cleanMessage, flag, flagData } = parseFlags(rawResponse);

    await sendText(from, cleanMessage);
    addMsg(from, "assistant", cleanMessage);

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

      let dateStr = updated.visit_day;
      let timeStr = updated.visit_hour;
      let calendarLink = "";

      // Crear evento en Google Calendar
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
        timeStr = eventData.startDate.toLocaleTimeString("es-CR", {
          hour: "2-digit", minute: "2-digit",
          timeZone: "America/Costa_Rica",
        });
        calendarLink = eventData.eventLink;
        console.log(`📅 Visita agendada en Calendar: ${calendarLink}`);
      } catch (calErr) {
        console.error("❌ Error creando evento en Calendar:", calErr.message);
      }

      // Enviar email de confirmación
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

      // Notificar a Melvin por WhatsApp
      await notifyMelvin(from, updated, normalized, "visita_solicitada");
      logLead(from, updated, "visita_solicitada");

      // Confirmación al cliente
      const calendarMsg = `✅ ¡Listo! Tu cita quedó agendada para el *${dateStr} a las ${timeStr}*. Te llegará una confirmación por correo y un recordatorio el día anterior 📧`;
      await sendText(from, calendarMsg);
    }

  } catch (err) {
    console.error("❌ Error:", err.message);
    await sendText(from,
      `Tuve un problema técnico 😔 Escribile directamente a *${KNOWLEDGE.empresa.encargado}* al ${KNOWLEDGE.empresa.whatsapp_melvin}.`
    );
  }
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
