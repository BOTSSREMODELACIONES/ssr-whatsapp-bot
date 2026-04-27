const { get, update, addMsg, reset, STAGE } = require("./state");
const { ask } = require("./claude");
const { sendText, sendButtons, sendList, markRead } = require("./messenger");
const KNOWLEDGE = require("./knowledge");

// ══════════════════════════════════════════════════════════════════════════════
// ENTRADA PRINCIPAL — procesa cada mensaje entrante
// ══════════════════════════════════════════════════════════════════════════════
async function handleMessage(from, text, messageId) {
  // Marcar como leído inmediatamente
  if (messageId) markRead(messageId).catch(() => {});

  const normalized = text.trim();
  const lower = normalized.toLowerCase();
  const session = get(from);

  // Comando de reset (solo en desarrollo)
  if (lower === "/reset" && process.env.NODE_ENV !== "production") {
    reset(from);
    await sendText(from, "🔄 Conversación reiniciada.");
    return;
  }

  // Si está escalado a humano, no intervenir
  if (session.escalated) return;

  try {
    // ── Flujo de agendamiento activo ──────────────────────────────────────
    if (isInVisitFlow(session.stage)) {
      await handleVisitFlow(from, normalized, session);
      return;
    }

    // ── Respuesta general con IA ──────────────────────────────────────────
    addMsg(from, "user", normalized);
    const aiResponse = await ask(session.history.slice(0, -1), normalized);

    // Detectar flags de Claude
    if (aiResponse.startsWith("[ESCALAR]")) {
      const msg = aiResponse.replace("[ESCALAR]", "").trim();
      await sendText(from, msg);
      await sendText(
        from,
        `📲 Te conecto ahora con *${KNOWLEDGE.empresa.encargado}* de nuestro equipo de proyectos. En un momento te contacta.`
      );
      update(from, { escalated: true, stage: STAGE.ESCALATED });
      await notifyMelvin(from, session, normalized, "escalación");
      addMsg(from, "assistant", msg);
      return;
    }

    if (aiResponse.startsWith("[AGENDAR]")) {
      const msg = aiResponse.replace("[AGENDAR]", "").trim();
      await sendText(from, msg);
      addMsg(from, "assistant", msg);
      await startVisitFlow(from);
      return;
    }

    if (aiResponse.startsWith("[LEAD]")) {
      const msg = aiResponse.replace("[LEAD]", "").trim();
      await sendText(from, msg);
      addMsg(from, "assistant", msg);
      if (!session.lead_saved) {
        update(from, { lead_saved: true });
        logLead(from, session);
      }
      return;
    }

    // Respuesta normal
    await sendText(from, aiResponse);
    addMsg(from, "assistant", aiResponse);
    update(from, { stage: STAGE.ACTIVE });

  } catch (err) {
    console.error("❌ handleMessage error:", err);
    await sendText(
      from,
      `Lo siento, tuve un problema técnico 😔 Escribí directamente al *${KNOWLEDGE.empresa.whatsapp_melvin}* con ${KNOWLEDGE.empresa.encargado}.`
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// FLUJO DE AGENDAMIENTO DE VISITA
// ══════════════════════════════════════════════════════════════════════════════

function isInVisitFlow(stage) {
  return [
    STAGE.VISIT_NAME, STAGE.VISIT_PROJECT, STAGE.VISIT_ZONE,
    STAGE.VISIT_DATETIME, STAGE.VISIT_CONFIRMING, STAGE.VISIT_PENDING_PAY,
  ].includes(stage);
}

async function startVisitFlow(from) {
  update(from, { stage: STAGE.VISIT_NAME });
  await sendText(
    from,
    `¡Perfecto! 🗓️ Vamos a agendar tu visita de diagnóstico (*${KNOWLEDGE.visita.costo_texto}*).\n\n¿Cuál es tu nombre completo?`
  );
}

async function handleVisitFlow(from, text, session) {
  switch (session.stage) {

    case STAGE.VISIT_NAME: {
      update(from, { name: text, stage: STAGE.VISIT_PROJECT });
      await sendText(
        from,
        `Mucho gusto, *${text}* 👋\n\n¿Qué tipo de trabajo necesitás? (Ej: remodelación de baño, pintura de casa, mueble de cocina, etc.)`
      );
      break;
    }

    case STAGE.VISIT_PROJECT: {
      update(from, { project_desc: text, stage: STAGE.VISIT_ZONE });
      await sendText(
        from,
        `Anotado 📝\n\n¿En qué cantón o zona está la propiedad?`
      );
      break;
    }

    case STAGE.VISIT_ZONE: {
      update(from, { zone: text, stage: STAGE.VISIT_DATETIME });
      await sendButtons(
        from,
        `¿Qué día de la semana te viene mejor para la visita? Trabajamos *lunes a sábado de 7am a 5pm* 📅`,
        [
          { id: "day_week",    title: "Entre semana" },
          { id: "day_sat",     title: "Sábado" },
          { id: "day_either",  title: "Cualquier día" },
        ],
        `Zona: ${text}`
      );
      break;
    }

    case STAGE.VISIT_DATETIME: {
      const dayPref = {
        day_week:   "entre semana (lunes a viernes)",
        day_sat:    "el sábado",
        day_either: "cualquier día",
      }[text] || text;

      update(from, { visit_date: dayPref, stage: STAGE.VISIT_CONFIRMING });

      const s = get(from);
      const summary =
        `✅ *Resumen de tu solicitud de visita:*\n\n` +
        `👤 Nombre: ${s.name}\n` +
        `🏗️ Proyecto: ${s.project_desc}\n` +
        `📍 Zona: ${s.zone}\n` +
        `📅 Preferencia: ${dayPref}\n` +
        `💰 Costo visita: *${KNOWLEDGE.visita.costo_texto}*\n\n` +
        `¿Confirmamos esta solicitud?`;

      await sendButtons(from, summary, [
        { id: "confirm_yes", title: "✅ Confirmar" },
        { id: "confirm_no",  title: "✏️ Cambiar algo" },
      ]);
      break;
    }

    case STAGE.VISIT_CONFIRMING: {
      if (text === "confirm_no" || text.toLowerCase().includes("cambi")) {
        update(from, { stage: STAGE.VISIT_NAME, name: null, project_desc: null, zone: null, visit_date: null });
        await sendText(from, "Sin problema, empezamos de nuevo 🔄\n\n¿Cuál es tu nombre completo?");
        break;
      }

      // Confirmado — registrar y notificar a Melvin para coordinar pago y fecha
      update(from, { stage: STAGE.VISIT_CONFIRMED, visit_confirmed: true });
      await sendText(
        from,
        `¡Listo, *${get(from).name}*! 🎉 Tu solicitud de visita quedó registrada.\n\n` +
        `*Melvin* de nuestro equipo te va a contactar en breve para coordinar el día, la hora y la forma de pago de la visita (*${KNOWLEDGE.visita.costo_texto}*). 📅\n\n` +
        `Podés pagar por SINPE Móvil, transferencia o efectivo al llegar — lo que te sea más cómodo.`
      );
      await notifyMelvin(from, get(from), "Confirmó solicitud de visita", "visita_pendiente");
      logLead(from, get(from), "visita_solicitada");
      break;
    }

    case STAGE.VISIT_PENDING_PAY: {
      // Estado de fallback — no debería llegar aquí con el nuevo flujo
      update(from, { stage: STAGE.VISIT_CONFIRMED });
      await sendText(
        from,
        `Gracias *${get(from).name}*! 😊 Melvin te va a contactar pronto para confirmar los detalles de la visita.`
      );
      await notifyMelvin(from, get(from), text, "visita_pendiente");
      break;
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// NOTIFICACIÓN A MELVIN
// ══════════════════════════════════════════════════════════════════════════════
async function notifyMelvin(from, session, lastMsg, tipo) {
  const tipos = {
    visita_pendiente: "🗓️ NUEVA SOLICITUD DE VISITA — pago pendiente",
    pago_confirmado:  "💰 PAGO DE VISITA CONFIRMADO — coordinar cita",
    escalación:       "🔔 CLIENTE ESCALADO — requiere atención humana",
  };

  const lines = [
    `${tipos[tipo] || "📋 NOTIFICACIÓN SSR Bot"}`,
    ``,
    `📱 WhatsApp cliente: ${from}`,
    session.name        ? `👤 Nombre: ${session.name}` : null,
    session.project_desc ? `🏗️ Proyecto: ${session.project_desc}` : null,
    session.zone        ? `📍 Zona: ${session.zone}` : null,
    session.visit_date  ? `📅 Preferencia: ${session.visit_date}` : null,
    ``,
    `💬 Último mensaje:`,
    `"${lastMsg}"`,
    ``,
    `_Enviado por Sasha, bot de SSR_`,
  ].filter(Boolean).join("\n");

  try {
    await sendText(KNOWLEDGE.empresa.whatsapp_melvin, lines);
    console.log(`✅ Melvin notificado [${tipo}] para ${from}`);
  } catch (err) {
    console.error("❌ Error notificando a Melvin:", err.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// REGISTRO DE LEADS
// ══════════════════════════════════════════════════════════════════════════════
function logLead(from, session, tipo = "lead") {
  const lead = {
    tipo,
    timestamp: new Date().toISOString(),
    phone: from,
    name: session.name || "—",
    project: session.project_desc || "—",
    zone: session.zone || "—",
    visit_confirmed: session.visit_confirmed || false,
  };
  console.log("📋 LEAD:", JSON.stringify(lead));
  // TODO: conectar a Google Sheets, Airtable, base de datos, etc.
}

module.exports = { handleMessage };
