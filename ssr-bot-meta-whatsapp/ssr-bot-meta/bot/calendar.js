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

  const description = [
    `👤 Cliente: ${name || "Sin nombre"}`,
    `📱 WhatsApp: ${phone}`,
    clientEmail && clientEmail !== "sin-correo" ? `📧 Email: ${clientEmail}` : "",
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

  // Armar lista de invitados
  const attendees = [];
  if (process.env.MELVIN_EMAIL) {
    attendees.push({ email: process.env.MELVIN_EMAIL });
  }
  if (clientEmail && clientEmail !== "sin-correo" && clientEmail.includes("@")) {
    attendees.push({ email: clientEmail });
  }

  const event = {
    summary: `🏗️ Visita SSR — ${name || "Cliente"} | ${zone || ""}`,
    description,
    start: { dateTime: startDate.toISOString(), timeZone: "America/Costa_Rica" },
    end: { dateTime: endDate.toISOString(), timeZone: "America/Costa_Rica" },
    attendees,
    reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 60 },     // Popup 1h antes
        { method: "email", minutes: 1440 },   // Email 24h antes a todos los invitados
      ],
    },
    colorId: "2",
  };

  const response = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    resource: event,
    sendUpdates: attendees.length > 0 ? "all" : "none",
  });

  console.log(`📅 Evento creado en Google Calendar: ${response.data.htmlLink}`);
  return {
    eventId: response.data.id,
    eventLink: response.data.htmlLink,
    startDate,
  };
}

module.exports = { createVisitEvent };
