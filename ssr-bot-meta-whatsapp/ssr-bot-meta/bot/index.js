const { get, update, addMsg, reset } = require("./state");
const { ask } = require("./claude");
const { sendText, markRead } = require("./messenger");
const { createVisitEvent } = require("./calendar");
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
      const [name, project, zone, day, hour, wazeLink] = (flagData || "").split("|");
      const updated = update(from, {
        name: name?.trim() || session.name,
        project_desc: project?.trim() || session.project_desc,
        zone: zone?.trim() || session.zone,
        visit_day: day?.trim() || "a coordinar",
        visit_hour: hour?.trim() || "09:00",
        waze_link: wazeLink?.trim() || "",
        visit_confirmed: true,
        lead_saved: true,
      });

      let calendarMsg = "";
      try {
        const eventData = await createVisitEvent({
          name: updated.name,
          phone: from,
          project: updated.project_desc,
          zone: updated.zone,
          day: updated.visit_day,
          hour: updated.visit_hour,
          wazeLink: updated.waze_link,
        });

        const dateStr = eventData.startDate.toLocaleDateString("es-CR", {
          weekday: "long", day: "numeric", month: "long",
          timeZone: "America/Costa_Rica",
        });
        const timeStr = eventData.startDate.toLocaleTimeString("es-CR", {
          hour: "2-digit", minute: "2-digit",
          timeZone: "America/Costa_Rica",
        });

        calendarMsg = `✅ Cita agendada para el *${dateStr} a las ${timeStr}*. Melvin ya recibió la notificación 👍`;
        console.log(`📅 Visita agendada en Calendar: ${eventData.eventLink}`);
      } catch (calErr) {
        console.error("❌ Error creando evento en Calendar:", calErr.message);
        calendarMsg = `ℹ️ Tu cita fue registrada. Melvin te confirmará los detalles pronto.`;
      }

      await notifyMelvin(from, updated, normalized, "visita_solicitada");
      logLead(from, updated, "visita_solicitada");

      if (calendarMsg) {
        await sendText(from, calendarMsg.trim());
      }
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
    session.waze_link    && `🗺️ Waze: ${session.waze_link}`,
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
    waze_link: session.waze_link || "—",
    visit: session.visit_confirmed || false,
  }));
}

module.exports = { handleMessage };
