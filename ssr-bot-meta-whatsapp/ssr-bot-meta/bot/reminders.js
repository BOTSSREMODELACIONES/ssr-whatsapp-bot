/**
 * reminders.js — Recordatorios automáticos de visitas
 * Se ejecuta diariamente a las 8:00 AM hora Costa Rica.
 * Consulta Google Calendar, extrae las visitas del día siguiente
 * y envía un WhatsApp de recordatorio a cada cliente + resumen a Melvin.
 */

const { google } = require("googleapis");
const { sendText } = require("./messenger");
const KNOWLEDGE = require("./knowledge");

// ── Calendar client ───────────────────────────────────────────────────────────
async function getCalendarClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  return google.calendar({ version: "v3", auth });
}

// ── Parsear la descripción del evento para extraer los datos del cliente ──────
function parseEventDescription(description = "") {
  const lines = description.split("\n");
  const get = (prefix) => {
    const line = lines.find((l) => l.startsWith(prefix));
    return line ? line.split(": ").slice(1).join(": ").trim() : null;
  };
  return {
    name:     get("👤 Cliente"),
    phone:    get("📱 WhatsApp"),
    email:    get("📧 Email cliente"),
    project:  get("🏗️ Proyecto"),
    zone:     get("📍 Zona"),
    location: get("🗺️ Ubicación"),
  };
}

// ── Formatear hora en formato 12h legible ─────────────────────────────────────
function formatTime(dateTimeStr) {
  const date = new Date(dateTimeStr);
  const hours = date.toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/Costa_Rica",
  });
  return hours.toLowerCase().replace("am", "a.m.").replace("pm", "p.m.");
}

// ── Formatear fecha larga ─────────────────────────────────────────────────────
function formatDate(dateTimeStr) {
  return new Date(dateTimeStr).toLocaleDateString("es-CR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "America/Costa_Rica",
  });
}

// ── Función principal ─────────────────────────────────────────────────────────
async function sendDailyReminders() {
  console.log("⏰ Iniciando recordatorios diarios...");

  try {
    const calendar = await getCalendarClient();

    // Calcular rango de mañana en hora CR
    const nowCR = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/Costa_Rica" })
    );
    const tomorrow = new Date(nowCR);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    const tomorrowEnd = new Date(tomorrow);
    tomorrowEnd.setHours(23, 59, 59, 0);

    // Consultar eventos de mañana
    const response = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: tomorrow.toISOString(),
      timeMax: tomorrowEnd.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = response.data.items || [];

    // Filtrar solo eventos de visitas SSR (los que creó el bot)
    const visits = events.filter((e) =>
      e.summary && e.summary.includes("Visita SSR")
    );

    if (visits.length === 0) {
      console.log("📅 Sin visitas programadas para mañana.");
      return;
    }

    console.log(`📅 ${visits.length} visita(s) mañana — enviando recordatorios...`);

    const summaryLines = [
      `📋 *VISITAS DE MAÑANA — ${formatDate(visits[0].start.dateTime)}*`,
      "",
    ];

    for (const event of visits) {
      const data = parseEventDescription(event.description);
      const timeStr = formatTime(event.start.dateTime);
      const dateStr = formatDate(event.start.dateTime);

      // ── Mensaje al cliente ───────────────────────────────────────────────
      if (data.phone) {
        const clientMsg = [
          `Hola${data.name ? ` *${data.name}*` : ""} 👋`,
          `Le recordamos su visita de diagnóstico con *SS Remodelaciones* mañana *${dateStr}* a las *${timeStr}*.`,
          "",
          `Nuestro equipo llegará puntualmente a su ubicación 📍`,
          `Recuerde que el costo de la visita es de *${KNOWLEDGE.visita.costo_texto}*, descontable si decide contratar la obra 😊`,
          "",
          `Si necesita reagendar o tiene alguna consulta, con gusto le ayudamos.`,
        ].join("\n");

        try {
          await sendText(data.phone, clientMsg);
          console.log(`✅ Recordatorio enviado a ${data.phone} (${data.name || "sin nombre"})`);
        } catch (err) {
          console.error(`❌ Error enviando recordatorio a ${data.phone}:`, err.message);
        }
      } else {
        console.warn(`⚠️ Evento sin teléfono: ${event.summary}`);
      }

      // Agregar al resumen para Melvin
      summaryLines.push(
        `🕐 *${timeStr}* — ${data.name || "Sin nombre"}`,
        data.project  ? `   🏗️ ${data.project}` : "",
        data.zone     ? `   📍 ${data.zone}` : "",
        data.phone    ? `   📱 ${data.phone}` : "",
        data.location && data.location !== "pendiente"
          ? `   🗺️ ${data.location}` : "",
        ""
      );
    }

    summaryLines.push(`_Total: ${visits.length} visita(s) — Sasha Bot SSR_`);

    // ── Resumen a Melvin ─────────────────────────────────────────────────────
    const melvinMsg = summaryLines.filter((l) => l !== undefined).join("\n");
    try {
      await sendText(KNOWLEDGE.empresa.whatsapp_melvin, melvinMsg);
      console.log("✅ Resumen del día enviado a Melvin");
    } catch (err) {
      console.error("❌ Error enviando resumen a Melvin:", err.message);
    }

  } catch (err) {
    console.error("❌ Error en sendDailyReminders:", err.message);
  }
}

module.exports = { sendDailyReminders };
