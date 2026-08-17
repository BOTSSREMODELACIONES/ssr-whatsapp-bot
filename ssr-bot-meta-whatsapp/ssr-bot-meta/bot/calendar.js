const { google } = require("googleapis");

// ── v12 — FIX "HOY MISMO" EN NOMBRES DE DÍA SIMPLES ───────────────────────────
// BUG: un cliente escribió "Lunes - se puede hoy?" un lunes a las 12pm. El
// v9/v10/v11 ya blindaba el caso de FECHA ESPECÍFICA que cae en día no hábil
// (el incidente del "viernes 8 de agosto" que en realidad era sábado), pero
// nunca tocó el caso de NOMBRE DE DÍA SIMPLE ("lunes"/"martes"/"viernes").
// Para ese caso, index.js le mandaba a Claude un mensaje de sistema que solo
// decía "Slots disponibles para lunes: ..." — sin la fecha real (el próximo
// lunes, calculado correctamente por getNextAvailableDate). Como el cliente
// preguntó explícitamente "¿se puede hoy?" y el sistema nunca aclaró que NO
// lo era, Claude — sin ninguna noción propia de la fecha de hoy — asumió que
// sí y ofreció el mismo día. Exactamente el mismo patrón de bug que el
// incidente del sábado, pero en el camino que nunca se corrigió.
// FIX: getAvailableSlots() ahora también devuelve dateLabel (la fecha real
// resuelta, ej. "lunes 24 de agosto"), para que index.js pueda decirle a
// Claude la fecha exacta y prohibir explícitamente decir "hoy mismo" —
// igual que ya se hace para el camino de fecha específica.
//
// FIX ADICIONAL: getNextAvailableDate() solo empujaba al día siguiente si YA
// había pasado la hora del slot pedido (now.getHours() >= hour). Eso dejaba
// una ventana real en las mañanas tempranas donde "hoy" sí calificaba como
// agendable — contradice la regla de negocio explícita de Darwin ("siempre
// el día hábil siguiente, sin excepción, sin importar la hora"). Ahora es
// incondicional.
// ─────────────────────────────────────────────────────────────────────────────

// ── v9 — Blindaje de días hábiles ─────────────────────────────────────────────
// BUG: getNextAvailableDate() solo validaba día hábil cuando recibía un
// NOMBRE de día ("lunes"/"martes"/"viernes", vía DAY_MAP). Cuando recibía
// una FECHA ESPECÍFICA (ej. "8 de agosto", vía parseSpecificDate), la usaba
// tal cual sin verificar en qué día de la semana caía. Como Claude calcula el
// día de la semana "de memoria" en la conversación y puede equivocarse (pasó
// con "viernes 8 de agosto" cuando el 8 es sábado), el sistema terminó
// agendando una visita en sábado — día que la empresa no trabaja — porque
// verificarDisponibilidadExacta solo revisa conflictos con otros eventos,
// no si el día es hábil.
// FIX: esDiaLaborable() se aplica en createVisitEvent() y getAvailableSlots()
// ANTES de cualquier consulta a Calendar. Si la fecha resultante no cae en
// lunes/martes/viernes, se rechaza con motivo "dia_no_laborable" sin
// necesidad de gastar una llamada a la API.
//
// ── v10 — Dos bugs adicionales de cómputo de fechas ───────────────────────────
// BUG A: parseSpecificDate() usaba `new Date().getFullYear()` (año del
//   SERVIDOR, que corre en UTC en Railway) como año por defecto cuando el
//   cliente no lo menciona. Cerca de medianoche, UTC y Costa Rica (UTC-6)
//   pueden estar en años distintos. FIX: nowCR() calcula "ahora" en zona
//   horaria de Costa Rica, y ese es el año que se usa por defecto.
// BUG B: cuando la fecha pedida ya había pasado este año, getNextAvailableDate
//   le sumaba "+7 días" a ciegas — sin relación real con la fecha pedida.
//   Ejemplo real: pedir "1 de agosto" el 4 de agosto resultaba en "8 de
//   agosto" (que además puede caer en día no hábil, como pasó). FIX: si la
//   fecha ya pasó y el cliente NO dio un año explícito, se interpreta como
//   el mismo día/mes del PRÓXIMO AÑO — el comportamiento correcto para una
//   fecha específica que ya pasó (igual que cualquier calendario real).
//   Si el cliente SÍ dio un año explícito y ya pasó, no se reinterpreta:
//   ese es un error del cliente/supervisor que debe corregirse explícitamente,
//   no algo que el sistema deba adivinar.
// ─────────────────────────────────────────────────────────────────────────────
const BUSINESS_DAYS = [1, 2, 5]; // 1=lunes, 2=martes, 5=viernes (0=domingo)

function esDiaLaborable(date) {
  return BUSINESS_DAYS.includes(date.getDay());
}

// "Ahora" en zona horaria de Costa Rica — usar SIEMPRE en vez de `new Date()`
// crudo para cualquier cómputo de año/día por defecto (el servidor corre en
// UTC en Railway).
function nowCR() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Costa_Rica" }));
}

// ── Próximos N días hábiles a partir de una fecha (sin incluirla) ────────────
// Se usa para darle a Sasha fechas REALES y ya calculadas cuando el cliente
// pide un día que no es laborable — así nunca tiene que inferir "el viernes
// más cercano" por su cuenta.
function proximosDiasHabiles(desde, cantidad = 3) {
  const resultado = [];
  const cursor = new Date(desde);
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() + 1);
  while (resultado.length < cantidad) {
    if (esDiaLaborable(cursor)) resultado.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return resultado;
}

// ── Parsear fecha específica (ej: "19 de mayo", "19/05", "2026-05-19") ────────
// Devuelve { date, explicitYear } o null. explicitYear indica si el año vino
// dado por el usuario (true) o se asumió el año actual en CR (false) — esto
// determina si getNextAvailableDate puede "adelantar" la fecha al próximo
// año cuando ya pasó, o si debe respetarla tal cual (año explícito = intención
// clara del usuario, no se reinterpreta).
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
      const explicitYear = !!m1[3];
      const year = explicitYear ? parseInt(m1[3]) : nowCR().getFullYear();
      return { date: new Date(year, month, parseInt(m1[1])), explicitYear };
    }
  }

  const m2 = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
  if (m2) {
    const explicitYear = !!m2[3];
    const year = explicitYear ? parseInt(m2[3]) : nowCR().getFullYear();
    return { date: new Date(year, parseInt(m2[2]) - 1, parseInt(m2[1])), explicitYear };
  }

  const m3 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m3) {
    return { date: new Date(parseInt(m3[1]), parseInt(m3[2]) - 1, parseInt(m3[3])), explicitYear: true };
  }

  return null;
}

// ── Convertir cualquier dateTime a minutos desde medianoche en hora CR ────────
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

  const now = nowCR();

  const parsed = parseSpecificDate(dayName);
  if (parsed) {
    const specificDate = parsed.date;
    specificDate.setHours(hour, minute, 0, 0);

    if (specificDate <= now) {
      if (parsed.explicitYear) {
        // El usuario dio un año explícito y ya pasó — no lo reinterpretamos,
        // eso sería adivinar la intención. Se deja tal cual; verificarDisponibilidadExacta
        // / esDiaLaborable seguirán aplicando sobre esta fecha (probablemente
        // resultará en un rechazo aguas abajo, que es lo correcto).
        console.warn(`⚠️ Calendar: fecha "${dayName}" con año explícito ya pasó. No se reinterpreta.`);
      } else {
        // v10 FIX: antes se sumaban "+7 días" a ciegas (sin relación con la
        // fecha pedida). Ahora se interpreta correctamente como el mismo
        // día/mes del PRÓXIMO AÑO.
        console.warn(`⚠️ Calendar: fecha "${dayName}" ya pasó este año, usando el próximo año.`);
        specificDate.setFullYear(specificDate.getFullYear() + 1);
      }
    }
    console.log(`📅 Calendar: fecha específica "${dayName}" → ${specificDate.toLocaleDateString("es-CR", { timeZone: "America/Costa_Rica", weekday:"long", day:"numeric", month:"long", year:"numeric" })}`);
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
  // v12 — FIX: antes esto solo empujaba a la próxima semana si YA había
  // pasado la hora del slot pedido (now.getHours() >= hour). Eso dejaba una
  // ventana real: si alguien escribía temprano en la mañana (antes de las
  // 9am) un lunes/martes/viernes preguntando por ese mismo día, el sistema
  // SÍ lo consideraba agendable hoy — contradiciendo la regla de negocio
  // explícita de Darwin ("las visitas siempre son para el día hábil
  // siguiente, sin excepción, sin importar la hora"). Ahora es incondicional.
  if (daysUntil === 0) daysUntil = 7;
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

function extraerTelefonoDeEvento(description) {
  if (!description) return null;
  const m = description.match(/WhatsApp:\s*\+?(\d{8,15})/i);
  if (m) {
    const digits = m[1];
    return digits.startsWith("506") ? `+${digits}` : `+506${digits}`;
  }
  const m2 = description.match(/\+?(506\d{8})/);
  return m2 ? `+${m2[1]}` : null;
}

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
    const dayStart = getNextAvailableDate(dayName, "09:00");

    // v12 — FIX: la etiqueta legible de la fecha REAL resuelta (ej: "lunes
    // 24 de agosto"), no solo el nombre de día que escribió el cliente. Sin
    // esto, index.js solo podía decirle a Claude "para lunes" — ambiguo
    // entre "hoy" y "el próximo lunes" — y Claude terminó asumiendo "hoy"
    // cuando el cliente preguntó explícitamente. Ahora se calcula acá y se
    // devuelve junto con los slots para que el mensaje de sistema pueda
    // ser inequívoco.
    const dateLabel = dayStart.toLocaleDateString("es-CR", {
      timeZone: "America/Costa_Rica",
      weekday: "long",
      day: "numeric",
      month: "long",
    });

    // ── v9: si la fecha resuelta no cae en día hábil (lunes/martes/viernes),
    // no tiene sentido ni siquiera consultar Calendar — no hay slots posibles.
    if (!esDiaLaborable(dayStart)) {
      console.warn(`⛔ getAvailableSlots: "${dayName}" cae en día NO laborable (${dayStart.toLocaleDateString("es-CR", { timeZone: "America/Costa_Rica", weekday: "long" })})`);
      return { date: dayStart, dateLabel, slots: [] };
    }

    const calendar = await getCalendarClient();

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

    console.log(`📅 Eventos encontrados para ${dayName} (${dateLabel}): ${events.length}`);

    const occupiedRanges = events.map(event => {
      if (event.start.date && !event.start.dateTime) {
        console.log(`🔒 Día completo bloqueado: "${event.summary}"`);
        return { startMin: 0, endMin: 24 * 60, allDay: true };
      }

      const startMin = toCRMinutes(event.start.dateTime);
      const endMin   = toCRMinutes(event.end.dateTime);
      const safeEndMin = endMin < startMin ? 23 * 60 + 59 : endMin;

      console.log(`🔒 Evento: "${event.summary}" → ${Math.floor(startMin/60)}:${String(startMin%60).padStart(2,'0')} – ${Math.floor(safeEndMin/60)}:${String(safeEndMin%60).padStart(2,'0')} (hora CR)`);
      return { startMin, endMin: safeEndMin, allDay: false };
    });

    const available = SLOTS.filter(slot => {
      const bloqueado = occupiedRanges.some(({ startMin, endMin, allDay }) => {
        if (allDay) return true;
        return (slot.startMin - 30) < endMin && (slot.endMin + 30) > startMin;
      });

      if (bloqueado) console.log(`⛔ Slot ${slot.label} bloqueado`);
      return !bloqueado;
    });

    const labels = available.map(s => s.label);
    console.log(`✅ Slots disponibles para ${dayName} (${dateLabel}): ${labels.join(", ") || "ninguno"}`);
    return { date: dayStart, dateLabel, slots: labels };

  } catch (err) {
    console.error("❌ Error consultando disponibilidad:", err.message);
    return { date: null, dateLabel: null, slots: [] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// verificarDisponibilidadExacta
// Verifica si una fecha/hora concreta está libre ANTES de crear el evento.
// A diferencia de getAvailableSlots (que trabaja sobre 3 slots fijos), esta
// función chequea el rango real [inicio, inicio+60min] de la cita que se va a
// crear, contra TODOS los eventos de ese día — incluyendo bloqueos de día
// completo (ej: Melvin reservó el día para instalar muebles).
//
// NOTA v9: esta función SOLO revisa conflictos con otros eventos. La
// validación de "¿es un día hábil?" vive en createVisitEvent() (se hace
// ANTES de llamar a esta función, para no gastar una consulta a la API en
// una fecha que de entrada nunca se iba a poder agendar).
//
// Devuelve:
//   { disponible: true }                            → se puede agendar
//   { disponible: false, motivo: "dia_bloqueado" }  → día completo reservado
//   { disponible: false, motivo: "slot_ocupado", conflicto: "..." }
//   { disponible: false, motivo: "error_calendario" } → falla al consultar
//     (por seguridad se trata como NO disponible; nunca se agenda a ciegas)
// ─────────────────────────────────────────────────────────────────────────────
async function verificarDisponibilidadExacta(startDate) {
  try {
    const calendar = await getCalendarClient();

    const dayStart = new Date(startDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(startDate);
    dayEnd.setHours(23, 59, 59, 999);

    const response = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: toLocalDateTimeString(dayStart) + "-06:00",
      timeMax: toLocalDateTimeString(dayEnd)   + "-06:00",
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = (response.data.items || []).filter(e => e.status !== "cancelled");

    // Rango de la cita que se quiere crear, en minutos CR
    const nuevoInicioMin = startDate.getHours() * 60 + startDate.getMinutes();
    const nuevoFinMin    = nuevoInicioMin + 60;

    for (const event of events) {
      // Evento de día completo → día bloqueado, no se agenda nada
      if (event.start.date && !event.start.dateTime) {
        console.log(`⛔ verificarDisponibilidadExacta: día bloqueado por "${event.summary}"`);
        return { disponible: false, motivo: "dia_bloqueado", conflicto: event.summary || "Día reservado" };
      }

      const evInicioMin = toCRMinutes(event.start.dateTime);
      let   evFinMin    = toCRMinutes(event.end.dateTime);
      if (evFinMin < evInicioMin) evFinMin = 23 * 60 + 59;

      // Solapamiento con margen de 30 min antes y después (igual que getAvailableSlots)
      const solapa = (nuevoInicioMin - 30) < evFinMin && (nuevoFinMin + 30) > evInicioMin;
      if (solapa) {
        console.log(`⛔ verificarDisponibilidadExacta: choca con "${event.summary}"`);
        return { disponible: false, motivo: "slot_ocupado", conflicto: event.summary || "Otra cita" };
      }
    }

    return { disponible: true };

  } catch (err) {
    console.error("❌ verificarDisponibilidadExacta error:", err.message);
    // SEGURIDAD: si no podemos verificar, NO agendamos a ciegas.
    return { disponible: false, motivo: "error_calendario" };
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

async function rescheduleEventByNameAndDate({ nameHint, dateHint, newDateHint, newHour }) {
  const { calendar, matched } = await buscarEventos({ nameHint, dateHint });

  if (matched.length === 0) {
    return { moved: 0, ambiguous: false, events: [] };
  }

  if (matched.length > 1) {
    const candidatos = matched.map(e => ({
      summary: e.summary,
      dateStr: formatearFechaEvento(e.start.dateTime || e.start.date),
    }));
    return { moved: 0, ambiguous: true, events: candidatos };
  }

  const event = matched[0];
  const oldDateStr = formatearFechaEvento(event.start.dateTime || event.start.date);

  let nuevaFecha = newDateHint ? resolveDateHint(newDateHint) : null;

  if (!nuevaFecha && !newHour) {
    return { moved: 0, ambiguous: false, events: [], error: "sin_nueva_fecha" };
  }

  if (!nuevaFecha) {
    nuevaFecha = new Date(new Date(event.start.dateTime || event.start.date)
      .toLocaleString("en-US", { timeZone: "America/Costa_Rica" }));
  }

  let hour = 9, minute = 0;
  if (newHour) {
    const parsed = parsearHora(newHour);
    hour   = parsed.hour;
    minute = parsed.minute;
  } else if (event.start.dateTime) {
    const minCR = toCRMinutes(event.start.dateTime);
    hour   = Math.floor(minCR / 60);
    minute = minCR % 60;
  }

  nuevaFecha.setHours(hour, minute, 0, 0);

  const now = nowCR();
  if (nuevaFecha <= now) {
    return { moved: 0, ambiguous: false, events: [], error: "fecha_pasada" };
  }

  // ── v9: si el destino cae en día NO laborable (lunes/martes/viernes),
  // rechazar de una vez — mismo blindaje que createVisitEvent.
  if (!esDiaLaborable(nuevaFecha)) {
    console.warn(`⛔ rescheduleEventByNameAndDate: destino "${newDateHint}" cae en día NO laborable`);
    return { moved: 0, ambiguous: false, events: [], error: "destino_ocupado", motivo: "dia_no_laborable", conflicto: null };
  }

  // v8: verificar que el destino esté libre antes de mover (respeta bloqueos)
  const dispo = await verificarDisponibilidadExacta(nuevaFecha);
  if (!dispo.disponible) {
    return { moved: 0, ambiguous: false, events: [], error: "destino_ocupado", motivo: dispo.motivo, conflicto: dispo.conflicto };
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

function parsearHora(str) {
  const s = String(str || "").trim().toLowerCase();
  const m = s.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/);
  if (!m) return { hour: 9, minute: 0 };

  let hour   = parseInt(m[1]) || 9;
  const minute = parseInt(m[2]) || 0;
  const sufijo = m[3] || "";

  if (/p/.test(sufijo) && hour < 12) hour += 12;
  if (/a/.test(sufijo) && hour === 12) hour = 0;
  if (!sufijo && hour >= 1 && hour <= 6) hour += 12;

  if (hour < 7)  hour = 9;
  if (hour > 17) hour = 16;

  return { hour, minute };
}

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

function resolveDateHint(hint) {
  if (!hint) return null;

  const s = hint.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const now = nowCR();

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
  const sDia = s.replace(/^(el|este|proximo|próximo|la)\s+/, "");
  if (DAY_MAP[sDia] !== undefined) {
    const target = DAY_MAP[sDia];
    const d = new Date(now);
    let diff = (target - d.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    d.setDate(d.getDate() + diff);
    return d;
  }

  // v10: unificar con la misma lógica de rollover-al-próximo-año que
  // getNextAvailableDate (antes esta rama no aplicaba ningún rollover).
  const parsed = parseSpecificDate(sDia) || parseSpecificDate(s);
  if (!parsed) return null;
  const d = parsed.date;
  if (d < now && !parsed.explicitYear) {
    d.setFullYear(d.getFullYear() + 1);
  }
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// createVisitEvent
// v8: VERIFICA disponibilidad (bloqueos/citas) antes de insertar.
// v9: TAMBIÉN verifica que el día resultante sea hábil (lunes/martes/viernes)
//   antes de cualquier otra cosa — esto es lo que evita que una fecha
//   específica mal etiquetada (ej. "viernes 8 de agosto" cuando el 8 es
//   sábado) termine agendando una visita en un día que la empresa no trabaja.
// Si el día no es hábil, o el slot está bloqueado/ocupado, NO crea el evento
// y devuelve { ok:false, motivo, conflicto } para que el llamador (flujo
// cliente o [VISITA:] de supervisor) informe en vez de duplicar/pisar la
// agenda o confirmar algo que no existe.
// ─────────────────────────────────────────────────────────────────────────────
async function createVisitEvent({ name, phone, project, zone, day, hour, wazeLink, clientEmail, skipAvailabilityCheck = false }) {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT) throw new Error("GOOGLE_SERVICE_ACCOUNT no configurado");
  if (!process.env.GOOGLE_CALENDAR_ID)     throw new Error("GOOGLE_CALENDAR_ID no configurado");

  const calendar = await getCalendarClient();

  const startDate = getNextAvailableDate(day, hour);

  if (!skipAvailabilityCheck) {
    // ── v9: PRIMERO validar día hábil (no gasta llamada a la API si ya de
    // entrada la fecha no es agendable).
    if (!esDiaLaborable(startDate)) {
      console.warn(`⛔ createVisitEvent abortado: "${day}" cae en día NO laborable (${startDate.toLocaleDateString("es-CR", { timeZone: "America/Costa_Rica", weekday: "long" })})`);
      return {
        ok: false,
        motivo: "dia_no_laborable",
        conflicto: null,
        startDate,
      };
    }

    // ── v8: VERIFICACIÓN DE DISPONIBILIDAD (respeta bloqueos y slots ocupados) ──
    // Se ejecuta ANTES de borrar citas previas o insertar nada. Si el destino
    // no está libre, abortamos sin tocar la agenda.
    const dispo = await verificarDisponibilidadExacta(startDate);
    if (!dispo.disponible) {
      console.warn(`⛔ createVisitEvent abortado: ${dispo.motivo} (${dispo.conflicto || "—"})`);
      return {
        ok: false,
        motivo: dispo.motivo,          // "dia_bloqueado" | "slot_ocupado" | "error_calendario"
        conflicto: dispo.conflicto || null,
        startDate,
      };
    }
  }

  const deleted = await cancelClientEvents(calendar, phone);
  if (deleted > 0) {
    console.log(`🔄 Reagendamiento: ${deleted} cita(s) anterior(es) eliminada(s) para ${phone}`);
  }

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
    ok:           true,
    eventId:      response.data.id,
    eventLink:    response.data.htmlLink,
    startDate,
    rescheduled:  deleted > 0,
  };
}

module.exports = {
  createVisitEvent,
  getAvailableSlots,
  verificarDisponibilidadExacta,
  cancelEventByNameAndDate,
  rescheduleEventByNameAndDate,
  listUpcomingEvents,
  esDiaLaborable,
  proximosDiasHabiles,
};
