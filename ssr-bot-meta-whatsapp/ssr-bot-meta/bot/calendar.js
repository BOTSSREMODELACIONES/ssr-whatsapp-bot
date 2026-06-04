const { google } = require("googleapis");

// ── Parsear fecha específica (ej: "19 de mayo", "19/05", "2026-05-19") ────────
function parseSpecificDate(str) {
  if (!str) return null;
  const s = str.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const MONTHS = {
    enero:0, febrero:1, marzo:2, abril:3, mayo:4, junio:5,
    julio:6, agosto:7, septiembre:8, octubre:9, noviembre:10, diciembre:11,
  };

  const m1 = s.match(/^(\d{1,2})\s+(?:de\s+)?([a-z]+)(?:\s+(\d{4}))?$/);
  if (m1) {
    const month = MONTHS[m1[2]];
    if (month !== undefined) {
      const year = m1[3] ? parseInt(m1[3]) : new Date().getFullYear();
      return new Date(year, month, parseInt(m1[1]));
    }
  }

  const m2 = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
  if (m2) {
    const year = m2[3] ? parseInt(m2[3]) : new Date().getFullYear();
    return new Date(year, parseInt(m2[2]) - 1, parseInt(m2[1]));
  }

  const m3 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m3) {
    return new Date(parseInt(m3[1]), parseInt(m3[2]) - 1, parseInt(m3[3]));
  }

  return null;
}

// ── Convertir cualquier dateTime a minutos desde medianoche en hora CR ────────
// Fix de zona horaria: no importa si Google devuelve UTC o -06:00,
// siempre extraemos la hora local en Costa Rica antes de comparar.
function toCRMinutes(dateTimeStr) {
  const d = new Date(dateTimeStr);
  const crStr = d.toLocaleString("en-US", {
    timeZone: "America/Costa_Rica",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const [h, m] = crStr.split(":").map(Number);
  return h * 60 + m;
}

// ── Obtener fecha agendable ───────────────────────────────────────────────────
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

  const specificDate = parseSpecificDate(dayName);
  if (specificDate) {
    specificDate.setHours(hour, minute, 0, 0);
    if (specificDate <= now) {
      console.warn(`⚠️ Calendar: fecha "${dayName}" ya pasó o es hoy, usando siguiente semana.`);
      specificDate.setDate(specificDate.getDate() + 7);
    }
    console.log(`📅 Calendar: fecha específica "${dayName}" → ${specificDate.toLocaleDateString("es-CR", { timeZone: "America/Costa_Rica", weekday:"long", day:"numeric", month:"long" })}`);
    return specificDate;
  }

  const normalized = (dayName || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const targetDay  = DAY_MAP[normalized];

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

// ─────────────────────────────────────────────────────────────────────────────
// getAvailableSlots — verifica disponibilidad real incluyendo eventos manuales
// ─────────────────────────────────────────────────────────────────────────────
async function getAvailableSlots(dayName) {
  const SLOTS = [
    { label: "09:00", startMin: 9 * 60,      endMin: 10 * 60 },
    { label: "11:30", startMin: 11 * 60 + 30, endMin: 12 * 60 + 30 },
    { label: "14:00", startMin: 14 * 60,      endMin: 15 * 60 },
  ];

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

    const events = (response.data.items || []).filter(e => e.status !== "cancelled");

    console.log(`📅 Eventos encontrados para ${dayName}: ${events.length}`);

    // Convertir cada evento a rango en minutos CR (zona horaria correcta)
    const occupiedRanges = events.map(event => {
      // Evento de todo el día → bloquea todo
      if (event.start.date && !event.start.dateTime) {
        console.log(`🔒 Día completo bloqueado: "${event.summary}"`);
        return { startMin: 0, endMin: 24 * 60, allDay: true };
      }

      // FIX: convertir a hora CR usando toCRMinutes, no timestamps crudos
      const startMin = toCRMinutes(event.start.dateTime);
      const endMin   = toCRMinutes(event.end.dateTime);
      const safeEndMin = endMin < startMin ? 23 * 60 + 59 : endMin;

      console.log(`🔒 Evento: "${event.summary}" → ${Math.floor(startMin/60)}:${String(startMin%60).padStart(2,'0')} – ${Math.floor(safeEndMin/60)}:${String(safeEndMin%60).padStart(2,'0')} (hora CR)`);
      return { startMin, endMin: safeEndMin, allDay: false };
    });

    // Filtrar slots que NO se solapan con ningún evento
    const available = SLOTS.filter(slot => {
      const bloqueado = occupiedRanges.some(({ startMin, endMin, allDay }) => {
        if (allDay) return true;
        // Solapamiento con margen de 30 min antes y después
        return (slot.startMin - 30) < endMin && (slot.endMin + 30) > startMin;
      });

      if (bloqueado) console.log(`⛔ Slot ${slot.label} bloqueado`);
      return !bloqueado;
    });

    const labels = available.map(s => s.label);
    console.log(`✅ Slots disponibles para ${dayName}: ${labels.join(", ") || "ninguno"}`);
    return labels;

  } catch (err) {
    console.error("❌ Error consultando disponibilidad:", err.message);
    // SEGURIDAD: si falla el calendario, NO ofrecer slots a ciegas
    return [];
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

// ─────────────────────────────────────────────────────────────────────────────
// cancelEventByNameAndDate
// Busca y elimina eventos por nombre de cliente y/o fecha.
// Usado por supervisores (Darwin / Melvin) via WhatsApp.
// ─────────────────────────────────────────────────────────────────────────────
async function cancelEventByNameAndDate({ nameHint, dateHint }) {
  const calendar = await getCalendarClient();

  const now    = new Date();
  const future = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

  let timeMin = now.toISOString();
  let timeMax = future.toISOString();

  if (dateHint) {
    const targetDate = resolveDateHint(dateHint);
    if (targetDate) {
      const dayStart = new Date(targetDate);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(targetDate);
      dayEnd.setHours(23, 59, 59, 999);
      timeMin = dayStart.toISOString();
      timeMax = dayEnd.toISOString();
      console.log(`🗓️ Buscando eventos el ${dayStart.toLocaleDateString("es-CR", { timeZone: "America/Costa_Rica" })}`);
    }
  }

  const response = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
    ...(nameHint ? { q: nameHint } : {}),
  });

  const events = (response.data.items || []).filter(e => e.status !== "cancelled");

  if (events.length === 0) {
    return { deleted: 0, events: [] };
  }

  // Filtro adicional por nombre en summary y description
  const normalizeStr = s => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const hintNorm = normalizeStr(nameHint || "");

  const matched = nameHint
    ? events.filter(e =>
        normalizeStr(e.summary).includes(hintNorm) ||
        normalizeStr(e.description || "").includes(hintNorm)
      )
    : events;

  if (matched.length === 0) {
    return { deleted: 0, events: [] };
  }

  const deleted = [];
  for (const event of matched) {
    const startRaw = event.start.dateTime || event.start.date;
    const dateStr  = new Date(startRaw).toLocaleString("es-CR", {
      timeZone: "America/Costa_Rica",
      weekday: "long", day: "numeric", month: "long",
      hour: "2-digit", minute: "2-digit",
    });

    await calendar.events.delete({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      eventId: event.id,
      sendUpdates: "none",
    });

    console.log(`🗑️ Evento cancelado por supervisor: "${event.summary}" (${dateStr})`);
    deleted.push({ summary: event.summary, dateStr });
  }

  return { deleted: deleted.length, events: deleted };
}

// ── Resolver referencia de fecha en lenguaje natural ────────────────────────
function resolveDateHint(hint) {
  if (!hint) return null;

  const s = hint.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Costa_Rica" }));

  if (s === "hoy") return now;
  if (s === "manana" || s === "mañana") {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d;
  }

  const DAY_MAP = { lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6, domingo: 0 };
  if (DAY_MAP[s] !== undefined) {
    const target = DAY_MAP[s];
    const d = new Date(now);
    let diff = (target - d.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    d.setDate(d.getDate() + diff);
    return d;
  }

  // Fecha específica ("5 de junio", "5/06", etc.) — reusar parseSpecificDate
  return parseSpecificDate(s);
}

// ─────────────────────────────────────────────────────────────────────────────

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

module.exports = { createVisitEvent, getAvailableSlots, cancelEventByNameAndDate };
