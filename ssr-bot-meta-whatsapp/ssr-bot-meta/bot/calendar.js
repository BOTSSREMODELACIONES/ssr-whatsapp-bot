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

function toLocalDateTimeString(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
}

async function getCalendarClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  return google.calendar({ version: "v3", auth });
}

async function getAvailableSlots(dayName) {
  const SLOTS = ["09:00", "11:30", "14:00"];

  try {
    const calendar = await getCalendarClient();

    const dayStart = getNextAvailableDate(dayName, "09:00");
    const dayEnd = new Date(dayStart);
    dayEnd.setHours(17, 0, 0, 0);

    const response = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: toLocalDateTimeString(dayStart) + "-06:00",
      timeMax: toLocalDateTimeString(dayEnd) + "-06:00",
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = response.data.items || [];

    const occupiedRanges = events.map(event => {
      const start = event.start.dateTime || event.start.date;
      return new Date(start).getTime();
    });

    const available = SLOTS.filter(slot => {
      const [h, m] = slot.split(":");
      const slotDate = new Date(dayStart);
      slotDate.setHours(parseInt(h), parseInt(m), 0, 0);
      const slotTime = slotDate.getTime();
      return !occupiedRanges.some(occupied =>
        Math.abs(occupied - slotTime) < 2.5 * 60 * 60 * 1000
      );
    });

    console.log(`📅 Slots disponibles para ${dayName}: ${available.join(", ") || "ninguno"}`);
    return available;

  } catch (err) {
    console.error("❌ Error consultando disponibilidad:", err.message);
    return ["09:00", "11:30", "14:00"];
  }
}

async function createVisitEvent({ name, phone, project, zone, day, hour, wazeLink, clientEmail }) {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT) throw new Error("GOOGLE_SERVICE_ACCOUNT no configurado");
  if (!process.env.GOOGLE_CALENDAR_ID) throw new Error("GOOGLE_CALENDAR_ID no configurado");

  const calendar = await getCalendarClient();
  const startDate = getNextAvailableDate(day, hour);
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);

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
    start: { dateTime: toLocalDateTimeString(startDate), timeZone: "America/Costa_Rica" },
    end: { dateTime: toLocalDateTimeString(endDate), timeZone: "America/Costa_Rica" },
    reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 60 },
        { method: "email", minutes: reminderMinutes },
      ],
    },
    colorId: "2",
  };

  const response = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    resource: eventBody,
    sendUpdates: "none",
  });

  console.log(`📅 Evento creado: ${response.data.htmlLink}`);
  return {
    eventId: response.data.id,
    eventLink: response.data.htmlLink,
    startDate,
  };
}

module.exports = { createVisitEvent, getAvailableSlots };
