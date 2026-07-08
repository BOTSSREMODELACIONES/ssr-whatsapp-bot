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

// ── NUEVO v7: extraer teléfono del cliente de la descripción del evento ──────
// Los eventos creados por Sasha llevan "📱 WhatsApp: +506XXXXXXXX" en la
// descripción. Esto permite notificar al cliente cuando un supervisor
// cancela o reagenda su cita.
function extraerTelefonoDeEvento(description) {
  if (!description) return null;
  const m = description.match(/WhatsApp:\s*\+?(\d{8,15})/i);
  if (m) {
    const digits = m[1];
    return digits.startsWith("506") ? `+${digits}` : `+506${digits}`;
  }
  // fallback: cualquier número de 11+ dígitos que empiece con 506
  const m2 = description.match(/\+?(506\d{8})/);
  return m2 ? `+${m2[1]}` : null;
}

// ── Formatear fecha de evento para mensajes ──────────────────────────────────
function formatearFechaEvento(startRaw) {
  return new Date(startRaw).toLocaleString("es-CR", {
    timeZone: "America/Costa_Rica",
    weekday: "long", day: "numeric", month: "long",
    hour: "2-digit", minute: "2-digit",
  });
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

// ── Búsqueda común de eventos por nombre y/o fecha ───────────────────────────
// Usada por cancelar, reagendar y consultar. Devuelve eventos "matched" con
// datos ya extraídos (teléfono del cliente incluido).
async function buscarEventos({ nameHint, dateHint }) {
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

  const normalizeStr = s => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const hintNorm = normalizeStr(nameHint || "");

  const matched = nameHint
    ? events.filter(e =>
        normalizeStr(e.summary).includes(hintNorm) ||
        normalizeStr(e.description || "").includes(hintNorm)
      )
    : events;

  return { calendar, matched };
}

// ─────────────────────────────────────────────────────────────────────────────
// cancelEventByNameAndDate
// Busca y elimina eventos por nombre de cliente y/o fecha.
// Usado por supervisores (Darwin / Melvin) via WhatsApp.
// v7: ahora devuelve también el teléfono del cliente de cada evento
// eliminado, para poder notificarle automáticamente.
// ─────────────────────────────────────────────────────────────────────────────
async function cancelEventByNameAndDate({ nameHint, dateHint }) {
  const { calendar, matched } = await buscarEventos({ nameHint, dateHint });

  if (matched.length === 0) {
    return { deleted: 0, events: [] };
  }

  const deleted = [];
  for (const event of matched) {
    const startRaw = event.start.dateTime || event.start.date;
    const dateStr  = formatearFechaEvento(startRaw);

    await calendar.events.delete({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      eventId: event.id,
      sendUpdates: "none",
    });

    console.log(`🗑️ Evento cancelado por supervisor: "${event.summary}" (${dateStr})`);
    deleted.push({
      summary:     event.summary,
      dateStr,
      clientPhone: extraerTelefonoDeEvento(event.description),
    });
  }

  return { deleted: deleted.length, events: deleted };
}

// ─────────────────────────────────────────────────────────────────────────────
// NUEVO v7 — rescheduleEventByNameAndDate
// Busca un evento por nombre y/o fecha actual, y lo mueve a una nueva
// fecha/hora. Usado por supervisores via WhatsApp:
//   "cambia la cita de Gabriela para el viernes a las 10"
//   "mueve la visita del martes al 15 de julio a las 2pm"
//
// Si hay más de un evento que coincide, NO mueve nada y devuelve la lista
// para que el supervisor especifique mejor (evita mover la cita equivocada).
// ─────────────────────────────────────────────────────────────────────────────
async function rescheduleEventByNameAndDate({ nameHint, dateHint, newDateHint, newHour }) {
  const { calendar, matched } = await buscarEventos({ nameHint, dateHint });

  if (matched.length === 0) {
    return { moved: 0, ambiguous: false, events: [] };
  }

  if (matched.length > 1) {
    // Ambiguo: devolver candidatos sin tocar nada
    const candidatos = matched.map(e => ({
      summary: e.summary,
      dateStr: formatearFechaEvento(e.start.dateTime || e.start.date),
    }));
    return { moved: 0, ambiguous: true, events: candidatos };
  }

  const event = matched[0];
  const oldDateStr = formatearFechaEvento(event.start.dateTime || event.start.date);

  // ── Resolver nueva fecha ───────────────────────────────────────────────────
  let nuevaFecha = newDateHint ? resolveDateHint(newDateHint) : null;

  if (!nuevaFecha && !newHour) {
    return { moved: 0, ambiguous: false, events: [], error: "sin_nueva_fecha" };
  }

  // Si solo cambia la hora, mantener el día actual del evento
  if (!nuevaFecha) {
    nuevaFecha = new Date(new Date(event.start.dateTime || event.start.date)
      .toLocaleString("en-US", { timeZone: "America/Costa_Rica" }));
  }

  // ── Resolver nueva hora ────────────────────────────────────────────────────
  let hour = 9, minute = 0;
  if (newHour) {
    const parsed = parsearHora(newHour);
    hour   = parsed.hour;
    minute = parsed.minute;
  } else if (event.start.dateTime) {
    // Mantener la hora original del evento (en hora CR)
    const minCR = toCRMinutes(event.start.dateTime);
    hour   = Math.floor(minCR / 60);
    minute = minCR % 60;
  }

  nuevaFecha.setHours(hour, minute, 0, 0);

  // Validar que la nueva fecha sea futura
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Costa_Rica" }));
  if (nuevaFecha <= now) {
    return { moved: 0, ambiguous: false, events: [], error: "fecha_pasada" };
  }

  const nuevoFin = new Date(nuevaFecha.getTime() + 60 * 60 * 1000);

  await calendar.events.patch({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    eventId:    event.id,
    resource: {
      start: { dateTime: toLocalDateTimeString(nuevaFecha), timeZone: "America/Costa_Rica" },
      end:   { dateTime: toLocalDateTimeString(nuevoFin),   timeZone: "America/Costa_Rica" },
    },
    sendUpdates: "none",
  });

  const newDateStr = nuevaFecha.toLocaleString("es-CR", {
    timeZone: "America/Costa_Rica",
    weekday: "long", day: "numeric", month: "long",
    hour: "2-digit", minute: "2-digit",
  });

  console.log(`🔄 Evento reagendado por supervisor: "${event.summary}" ${oldDateStr} → ${newDateStr}`);

  return {
    moved: 1,
    ambiguous: false,
    events: [{
      summary:     event.summary,
      oldDateStr,
      newDateStr,
      clientPhone: extraerTelefonoDeEvento(event.description),
    }],
  };
}

// ── Parsear hora en formatos comunes: "10:00", "10", "2pm", "2:30 pm", "14.30"
function parsearHora(str) {
  const s = String(str || "").trim().toLowerCase();
  const m = s.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/);
  if (!m) return { hour: 9, minute: 0 };

  let hour   = parseInt(m[1]) || 9;
  const minute = parseInt(m[2]) || 0;
  const sufijo = m[3] || "";

  if (/p/.test(sufijo) && hour < 12) hour += 12;
  if (/a/.test(sufijo) && hour === 12) hour = 0;
  // Sin sufijo: horas 1-6 se asumen de la tarde (nadie agenda visitas a las 2am)
  if (!sufijo && hour >= 1 && hour <= 6) hour += 12;

  if (hour < 7)  hour = 9;
  if (hour > 17) hour = 16;

  return { hour, minute };
}

// ─────────────────────────────────────────────────────────────────────────────
// NUEVO v7 — listUpcomingEvents
// Lista las citas próximas (opcionalmente de un día específico) para que el
// supervisor consulte la agenda: "qué citas hay mañana", "agenda del viernes".
// ─────────────────────────────────────────────────────────────────────────────
async function listUpcomingEvents({ dateHint } = {}) {
  const calendar = await getCalendarClient();

  const now = new Date();
  let timeMin = now.toISOString();
  let timeMax = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

  if (dateHint) {
    const targetDate = resolveDateHint(dateHint);
    if (targetDate) {
      const dayStart = new Date(targetDate);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(targetDate);
      dayEnd.setHours(23, 59, 59, 999);
      timeMin = dayStart.toISOString();
      timeMax = dayEnd.toISOString();
    }
  }

  const response = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 20,
  });

  const events = (response.data.items || []).filter(e => e.status !== "cancelled");

  return events.map(e => ({
    summary: e.summary,
    dateStr: formatearFechaEvento(e.start.dateTime || e.start.date),
    clientPhone: extraerTelefonoDeEvento(e.description),
  }));
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
  if (s === "pasado manana" || s === "pasado mañana") {
    const d = new Date(now);
    d.setDate(d.getDate() + 2);
    return d;
  }

  const DAY_MAP = { lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6, domingo: 0 };
  // Aceptar "el viernes", "proximo viernes", "este viernes"
  const sDia = s.replace(/^(el|este|proximo|próximo|la)\s+/, "");
  if (DAY_MAP[sDia] !== undefined) {
    const target = DAY_MAP[sDia];
    const d = new Date(now);
    let diff = (target - d.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    d.setDate(d.getDate() + diff);
    return d;
  }

  // Fecha específica ("5 de junio", "5/06", etc.) — reusar parseSpecificDate
  return parseSpecificDate(sDia) || parseSpecificDate(s);
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

module.exports = {
  createVisitEvent,
  getAvailableSlots,
  cancelEventByNameAndDate,
  rescheduleEventByNameAndDate,
  listUpcomingEvents,
};
