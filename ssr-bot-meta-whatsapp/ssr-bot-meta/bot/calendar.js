const { google } = require("googleapis");

// ── Parsear fecha específica (ej: "19 de mayo", "19/05", "2026-05-19") ────────
// Devuelve un objeto Date si se reconoce el formato, o null si no
function parseSpecificDate(str) {
  if (!str) return null;
  const s = str.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const MONTHS = {
    enero:0, febrero:1, marzo:2, abril:3, mayo:4, junio:5,
    julio:6, agosto:7, septiembre:8, octubre:9, noviembre:10, diciembre:11,
  };

  // "19 de mayo" / "19 mayo"
  const m1 = s.match(/^(\d{1,2})\s+(?:de\s+)?([a-z]+)(?:\s+(\d{4}))?$/);
  if (m1) {
    const month = MONTHS[m1[2]];
    if (month !== undefined) {
      const year = m1[3] ? parseInt(m1[3]) : new Date().getFullYear();
      return new Date(year, month, parseInt(m1[1]));
    }
  }

  // "19/05" / "19/05/2026"
  const m2 = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
  if (m2) {
    const year = m2[3] ? parseInt(m2[3]) : new Date().getFullYear();
    return new Date(year, parseInt(m2[2]) - 1, parseInt(m2[1]));
  }

  // "2026-05-19"
  const m3 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m3) {
    return new Date(parseInt(m3[1]), parseInt(m3[2]) - 1, parseInt(m3[3]));
  }

  return null;
}

// ── Obtener fecha agendable ───────────────────────────────────────────────────
// dayName: puede ser "lunes"/"martes"/"viernes" O una fecha específica
function getNextAvailableDate(dayName, hourStr) {
  const DAY_MAP = { lunes: 1, martes: 2, viernes: 5 };

  let hour = 9, minute = 0;
  if (hourStr) {
    const parts = hourStr.replace(":", ".").split(".");
    hour   = parseInt(parts[0]) || 9;
    minute = parseInt(parts[1]) || 0;
    if (hour < 9)  hour = 9;
    if (hour > 16) hour = 16;
  }

  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Costa_Rica" }));

  // ── NUEVO: manejar fechas específicas ────────────────────────────────────────
  const specificDate = parseSpecificDate(dayName);
  if (specificDate) {
    specificDate.setHours(hour, minute, 0, 0);

    // Si la fecha ya pasó (o es hoy pero la hora ya pasó), agregar 7 días como fallback
    if (specificDate <= now) {
      console.warn(`⚠️ Calendar: fecha "${dayName}" ya pasó o es hoy, usando siguiente semana.`);
      specificDate.setDate(specificDate.getDate() + 7);
    }

    console.log(`📅 Calendar: fecha específica "${dayName}" → ${specificDate.toLocaleDateString("es-CR", { timeZone: "America/Costa_Rica", weekday:"long", day:"numeric", month:"long" })}`);
    return specificDate;
  }

  // ── Lógica original para nombres de días ────────────────────────────────────
  const normalized = (dayName || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const targetDay  = DAY_MAP[normalized];

  const result = new Date(now);
  result.setHours(hour, minute, 0, 0);

  if (targetDay === undefined) {
    // Fallback: próximo lunes
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
    const dayEnd   = new Date(dayStart);
    dayEnd.setHours(17, 0, 0, 0);

    const response = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: toLocalDateTimeString(dayStart) + "-06:00",
      timeMax: toLocalDateTimeString(dayEnd)   + "-06:00",
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

// ── Buscar y eliminar eventos futuros de un cliente por teléfono ─────────────
async function cancelClientEvents(calendar, phone) {
  try {
    const now    = new Date();
    const future = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    const response = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: now.toISOString(),
      timeMax: future.toISOString(),
      singleEvents: true,
      q: phone,
    });

    const events = response.data.items || [];
    const clientEvents = events.filter(e =>
      e.description && (
        e.description.includes(phone) ||
        e.description.includes(phone.replace("+", ""))
      )
    );

    for (const event of clientEvents) {
      await calendar.events.delete({
        calendarId: process.env.GOOGLE_CALENDAR_ID,
        eventId: event.id,
        sendUpdates: "none",
      });
      console.log(`🗑️ Evento anterior eliminado: "${event.summary}" (${event.id})`);
    }

    return clientEvents.length;
  } catch (err) {
    console.error("❌ Error eliminando eventos anteriores:", err.message);
    return 0;
  }
}

async function createVisitEvent({ name, phone, project, zone, day, hour, wazeLink, clientEmail }) {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT) throw new Error("GOOGLE_SERVICE_ACCOUNT no configurado");
  if (!process.env.GOOGLE_CALENDAR_ID)     throw new Error("GOOGLE_CALENDAR_ID no configurado");

  const calendar = await getCalendarClient();

  const deleted = await cancelClientEvents(calendar, phone);
  if (deleted > 0) {
    console.log(`🔄 Reagendamiento: ${deleted} cita(s) anterior(es) eliminada(s) para ${phone}`);
  }

  const startDate = getNextAvailableDate(day, hour);
  const endDate   = new Date(startDate.getTime() + 60 * 60 * 1000);

  const hoursUntilEvent   = (startDate.getTime() - Date.now()) / (1000 * 60 * 60);
  const reminderMinutes   = hoursUntilEvent > 24 ? 1440 : 180;

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
    "─────────────────────────────────",
    "Agendado automáticamente por Sasha — Bot SS Remodelaciones",
  ].filter(Boolean).join("\n");

  const eventBody = {
    summary:     `🏗️ Visita SSR — ${name || "Cliente"} | ${zone || ""}`,
    description,
    start: { dateTime: toLocalDateTimeString(startDate), timeZone: "America/Costa_Rica" },
    end:   { dateTime: toLocalDateTimeString(endDate),   timeZone: "America/Costa_Rica" },
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
    resource:   eventBody,
    sendUpdates: "none",
  });

  console.log(`📅 Evento creado: ${response.data.htmlLink}`);
  return {
    eventId:      response.data.id,
    eventLink:    response.data.htmlLink,
    startDate,
    rescheduled:  deleted > 0,
  };
}

module.exports = { createVisitEvent, getAvailableSlots };
