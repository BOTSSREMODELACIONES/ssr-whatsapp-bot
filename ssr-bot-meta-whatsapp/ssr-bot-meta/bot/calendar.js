const { google } = require("googleapis");

function getNextAvailableDate(dayName, hourStr) {
  const DAY_MAP = { lunes: 1, martes: 2, viernes: 5 };
  const normalized = dayName.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const targetDay = DAY_MAP[normalized];

  let hour = 9;
  let minute = 0;
  if (hourStr) {
    const parts = hourStr.replace(":", ".").split(".");
    hour = parseInt(parts[0]) || 9;
    minute = parseInt(parts[1]) || 0;
    if (hour < 9) hour = 9;
    if (hour > 16) hour = 16;
  }

  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Costa_Rica" }));
  const result = new Date(now);
  result.setHours(hour, minute, 0, 0);

  if (targetDay === undefined) {
    const daysUntilMonday = (8 - result.getDay()) % 7 || 7;
    result.setDate(result.getDate() + daysUntilMonday);
    return result;
  }

  const currentDay = result.getDay();
  let daysUntil = (targetDay - currentDay + 7) % 7;
  if (daysUntil === 0 && now.getHours() >= hour) daysUntil = 7;
  result.setDate(result.getDate() + daysUntil);
  return result;
}

async function createVisitEvent({ name, phone, project, zone, day, hour, wazeLink, clientEmail }) {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT no configurado");
  }
  if (!process.env.GOOGLE_CALENDAR_ID) {
    throw new Error("GOOGLE_CALENDAR_ID no configurado");
  }

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  const calendar = google.calendar({ version: "v3", auth });
  const startDate = getNextAvailableDate(day, hour);
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);

  // Recordatorio inteligente: más de 24h → recordatorio 24h antes, menos → 3h antes
  const hoursUntilEvent = (startDate.getTime() - Date.now()) / (1000 * 60 * 60);
  const reminderMinutes = hoursUntilEvent > 24 ? 1440 : 180;

  const description = [
    `👤 Cliente: ${name || "Sin nombre"}`,
    `📱 WhatsApp: ${phone}`,
    clientEmail && clientEmail !== "sin-correo" ? `📧 Email cliente: ${clientEmail}` : "",
    `🏗️ Proyecto: ${project || "Por definir"}`,
    `📍 Zona: ${zone || "Por definir"}`,
    wazeLink ? `🗺️ Ubicación: ${wazeLink}` : "🗺️ Ubicación: pendiente",
    "",
    "💰 Costo visita: ₡25.000 (descontable si contrata obra)",
    "⏱️ Duración aprox: 1 hora",
    "",
    "─────────────────────────",
    "Agendado automáticamente por Sasha — Bot SS Remodelaciones",
  ].filter(Boolean).join("\n");

  const eventBody = {
    summary: `🏗️ Visita SSR — ${name || "Cliente"} | ${zone || ""}`,
    description,
    start: { dateTime: startDate.toISOString(), timeZone: "America/Costa_Rica" },
    end: { dateTime: endDate.toISOString(), timeZone: "America/Costa_Rica" },
    reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 60 },
        { method: "email", minutes: reminderMinutes },
      ],
    },
    colorId: "2",
  };

  // Calendarios donde se crea el evento
  const calendarIds = [process.env.GOOGLE_CALENDAR_ID];
  if (process.env.GOOGLE_CALENDAR_GERENCIA) calendarIds.push(process.env.GOOGLE_CALENDAR_GERENCIA);
  if (process.env.GOOGLE_CALENDAR_PROYECTOS) calendarIds.push(process.env.GOOGLE_CALENDAR_PROYECTOS);

  let mainEvent = null;
  for (const calId of calendarIds) {
    try {
      const response = await calendar.events.insert({
        calendarId: calId,
        resource: eventBody,
        sendUpdates: "none",
      });
      console.log(`📅 Evento creado en calendario ${calId}: ${response.data.htmlLink}`);
      if (!mainEvent) mainEvent = response.data;
    } catch (err) {
      console.error(`❌ Error creando evento en ${calId}:`, err.message);
    }
  }

  if (!mainEvent) throw new Error("No se pudo crear el evento en ningún calendario");

  return {
    eventId: mainEvent.id,
    eventLink: mainEvent.htmlLink,
    startDate,
  };
}

module.exports = { createVisitEvent };
