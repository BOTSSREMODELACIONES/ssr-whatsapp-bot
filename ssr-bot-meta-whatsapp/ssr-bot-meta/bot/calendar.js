const { google } = require("googleapis");

// ── v15 — HORARIO ÚNICO: 9:00 a.m. (lunes, martes, viernes) ──────────────────
// A petición de Darwin: Sasha ya no debe ofrecer múltiples horarios por día
// (antes: 09:00, 11:30, 14:00). A partir de ahora el ÚNICO horario que se
// ofrece a los clientes es las 9:00 a.m., en los mismos 3 días hábiles de
// siempre (lunes, martes, viernes). Esto simplifica getAvailableSlots() a un
// solo slot, y reduce el flujo de conversación de Sasha a "¿qué día le
// sirve?" en vez de "¿qué día y qué hora?".
//
// IMPORTANTE: esto NO afecta la lógica de verificación de disponibilidad —
// verificarDisponibilidadExacta() sigue revisando TODOS los eventos del día
// completo (no solo el rango 9:00-10:00), así que una cita introducida
// manualmente por un administrador a cualquier hora del día sigue bloqueando
// correctamente el slot de las 9:00 a.m. si cae dentro del margen de 30 min
// de colchón. Ver también el refuerzo de comentarios en
// verificarDisponibilidadExacta() más abajo.
// ─────────────────────────────────────────────────────────────────────────────

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

// ── v16 (11 septiembre 2026) — FIX CRÍTICO DOBLE: "Sasha choca contra su
//    propia cita recién creada" ────────────────────────────────────────────
//
// BUG REAL (reportado por Darwin con capturas de WhatsApp): a una clienta
// (Shirley Vargas) se le confirmó el viernes 18 de septiembre a las 9:00
// a.m., se le pidió dirección y correo, y el sistema emitió "NUEVA VISITA
// AGENDADA... Visita confirmada automáticamente por Sasha." Milisegundos
// después, para el MISMO cliente y el MISMO horario, apareció una SEGUNDA
// "NUEVA VISITA AGENDADA" que esta vez falló con "⚠️ Intento de agendar
// chocó con un bloqueo/cita existente (slot_ocupado)" — y el conflicto
// reportado fue justamente "🏗️ Visita SSR — ... | Heredia - San Isidro",
// es decir, EL EVENTO QUE EL PROPIO SISTEMA ACABABA DE CREAR un mensaje
// antes para ese mismo cliente. Sasha, sin saber que ese "conflicto" era
// la cita de su propio cliente, le dijo que el horario ya no estaba
// disponible y arrancó a ofrecer fechas alternativas — confundiendo
// muchísimo a una clienta que ya tenía su cita bien agendada.
//
// CAUSA RAÍZ (dos bugs combinados):
//
// 1) verificarDisponibilidadExacta() revisa TODOS los eventos del día sin
//    excepción — correcto para no pisar citas de otros clientes o bloqueos
//    de administradores, pero no tenía forma de reconocer "este evento en
//    conflicto es la cita que ya tiene ESTE MISMO cliente" (algo que sí
//    puede pasar si createVisitEvent() se invoca dos veces seguidas para
//    la misma solicitud — típicamente por un reintento de entrega de
//    webhook de WhatsApp procesando el mismo mensaje dos veces, algo que
//    debe revisarse en index.js, fuera de este archivo).
//
// 2) extraerTelefonoDeEvento() agravaba esto: para CUALQUIER número que no
//    empezara con "506", le anteponía "+506" a ciegas — pensado para
//    números locales costarricenses de 8 dígitos, pero aplicado también a
//    números que YA venían con código de país (ej. el "+17542496480" del
//    caso real), produciendo un número completamente distinto
//    ("+50617542496480"). Esto habría roto cualquier intento de comparar
//    "es el mismo cliente" por teléfono, aunque se hubiera agregado esa
//    comparación.
//
// FIX (dos partes):
//   a) extraerTelefonoDeEvento() ahora solo antepone "+506" cuando el
//      número extraído tiene exactamente 8 dígitos (formato local CR sin
//      código de país). Para cualquier otra longitud, se asume que ya
//      viene con código de país y solo se le agrega el "+".
//   b) verificarDisponibilidadExacta() acepta un parámetro opcional
//      `phone`. Al revisar cada evento del día, si el teléfono del evento
//      en conflicto coincide con `phone` (comparando los últimos 8
//      dígitos, para tolerar diferencias menores de formato), ese evento
//      se IGNORA como conflicto — es una cita propia de este mismo
//      cliente, que createVisitEvent() de todas formas reemplaza vía
//      cancelClientEvents() antes de insertar la nueva. createVisitEvent()
//      ahora pasa el teléfono del cliente en esa llamada.
//
// Esto no resuelve por sí solo la causa de fondo de por qué
// createVisitEvent() se está invocando dos veces para la misma solicitud
// (eso vive en index.js, que hay que revisar aparte), pero sí hace que,
// aunque eso vuelva a pasar, el sistema nunca le diga a un cliente que su
// propia cita recién confirmada "ya no está disponible".
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
// NOTA v15: aunque el flujo de cliente ahora solo ofrece 9:00 a.m., esta
// función se sigue usando también para reagendamientos manuales de
// supervisores (que pueden necesitar otra hora puntual), por eso conserva el
// parámetro hourStr y su clamp 9–16. El horario único de 9:00 a.m. se
// garantiza en la capa de arriba (getAvailableSlots + el system prompt de
// Sasha), no acá.
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
        console.warn(`⚠️ Calendar: fecha "${dayName}" con año explícito ya pasó. No se reinterpreta.`);
      } else {
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
    if (digits.length === 8) return `+506${digits}`;
    return `+${digits}`;
  }
  const m2 = description.match(/\+?(506\d{8})/);
  return m2 ? `+${m2[1]}` : null;
}

function normalizarTelefono(tel) {
  return String(tel || "").replace(/\D/g, "").slice(-8);
}

function formatearFechaEvento(startRaw) {
  return new Date(startRaw).toLocaleString("es-CR", {
    timeZone: "America/Costa_Rica",
    weekday: "long", day: "numeric", month: "long",
    hour: "2-digit", minute: "2-digit",
  });
}

// ── v18 (16 sept 2026) — Parser de la descripción que arma createVisitEvent ──
// Extrae los campos que createVisitEvent() escribe en la descripción del
// evento (👤 Cliente / 📱 WhatsApp / 📧 Email cliente / 🏗️ Proyecto /
// 📍 Zona), para reutilizarlos en el nuevo módulo de confirmación de visitas
// (confirmaciones.js) sin tener que rearmar ese parseo ahí. Cada línea de la
// descripción es su propio campo, así que `.+` (que en JS por defecto no
// cruza saltos de línea) alcanza para capturar el valor completo de cada una.
function parseDescripcionEvento(description) {
  const desc = String(description || "");

  function campo(regex) {
    const m = desc.match(regex);
    return m ? m[1].trim() : "";
  }

  return {
    cliente:  campo(/👤 Cliente:\s*(.+)/),
    phone:    campo(/📱 WhatsApp:\s*(.+)/),
    email:    campo(/📧 Email cliente:\s*(.+)/),
    proyecto: campo(/🏗️ Proyecto:\s*(.+)/),
    zona:     campo(/📍 Zona:\s*(.+)/),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// getAvailableSlots — verifica disponibilidad real incluyendo eventos manuales
//
// v15: un único slot posible por día — 9:00 a.m. (antes: 09:00, 11:30, 14:00).
// El chequeo de conflicto sigue siendo contra TODOS los eventos del día
// (calendar.events.list sin filtrar por origen), así que una cita puesta a
// mano por un administrador a cualquier hora bloquea este slot igual que
// bloqueaba los tres anteriores.
// ─────────────────────────────────────────────────────────────────────────────
async function getAvailableSlots(dayName) {
  const SLOTS = [
    { label: "09:00", startMin: 9 * 60, endMin: 10 * 60 },
  ];

  try {
    const dayStart = getNextAvailableDate(dayName, "09:00");

    const dateLabel = dayStart.toLocaleDateString("es-CR", {
      timeZone: "America/Costa_Rica",
      weekday: "long",
      day: "numeric",
      month: "long",
    });

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
// ─────────────────────────────────────────────────────────────────────────────
async function verificarDisponibilidadExacta(startDate, phone = null) {
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

    const nuevoInicioMin = startDate.getHours() * 60 + startDate.getMinutes();
    const nuevoFinMin    = nuevoInicioMin + 60;

    const phoneNorm = phone ? normalizarTelefono(phone) : null;

    for (const event of events) {
      if (event.start.date && !event.start.dateTime) {
        console.log(`⛔ verificarDisponibilidadExacta: día bloqueado por "${event.summary}"`);
        return { disponible: false, motivo: "dia_bloqueado", conflicto: event.summary || "Día reservado" };
      }

      if (phoneNorm) {
        const telefonoEvento = extraerTelefonoDeEvento(event.description);
        if (telefonoEvento && normalizarTelefono(telefonoEvento) === phoneNorm) {
          console.log(`↪️ verificarDisponibilidadExacta: conflicto ignorado — "${event.summary}" es una cita propia del mismo cliente (${phone})`);
          continue;
        }
      }

      const evInicioMin = toCRMinutes(event.start.dateTime);
      let   evFinMin    = toCRMinutes(event.end.dateTime);
      if (evFinMin < evInicioMin) evFinMin = 23 * 60 + 59;

      const solapa = (nuevoInicioMin - 30) < evFinMin && (nuevoFinMin + 30) > evInicioMin;
      if (solapa) {
        console.log(`⛔ verificarDisponibilidadExacta: choca con "${event.summary}"`);
        return { disponible: false, motivo: "slot_ocupado", conflicto: event.summary || "Otra cita" };
      }
    }

    return { disponible: true };

  } catch (err) {
    console.error("❌ verificarDisponibilidadExacta error:", err.message);
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

  if (!esDiaLaborable(nuevaFecha)) {
    console.warn(`⛔ rescheduleEventByNameAndDate: destino "${newDateHint}" cae en día NO laborable`);
    return { moved: 0, ambiguous: false, events: [], error: "destino_ocupado", motivo: "dia_no_laborable", conflicto: null };
  }

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

// ── v18 (16 sept 2026) — NUEVO: listado de visitas de un día con TODOS sus
// datos (nombre, teléfono, hora, proyecto, zona), para el módulo de
// confirmación de visitas (confirmaciones.js). A diferencia de
// listUpcomingEvents() (pensado para que un supervisor pregunte "qué citas
// hay" y solo necesita un resumen de texto), esta función devuelve los
// campos estructurados que createVisitEvent() ya escribe en la descripción
// del evento, parseados con parseDescripcionEvento(). Se filtra únicamente
// a eventos cuyo summary contiene "Visita SSR" — el prefijo fijo que
// createVisitEvent() siempre usa — para no confundir con bloqueos internos
// u otros eventos que un administrador haya puesto directo en el calendario
// y que no son visitas de cliente.
async function listVisitsForDate(dateHint) {
  const calendar = await getCalendarClient();

  const targetDate = resolveDateHint(dateHint);
  if (!targetDate) return [];

  const dayStart = new Date(targetDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(targetDate);
  dayEnd.setHours(23, 59, 59, 999);

  const response = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = (response.data.items || []).filter(e =>
    e.status !== "cancelled" &&
    (e.summary || "").includes("Visita SSR")
  );

  return events.map(e => {
    const info = parseDescripcionEvento(e.description);
    const startRaw = e.start.dateTime || e.start.date;

    const hourStr = e.start.dateTime
      ? new Date(e.start.dateTime).toLocaleString("es-CR", {
          timeZone: "America/Costa_Rica", hour: "numeric", minute: "2-digit", hour12: true,
        })
      : "";

    return {
      eventId:  e.id,
      summary:  e.summary,
      dateStr:  formatearFechaEvento(startRaw),
      hourStr,
      name:     info.cliente || (e.summary || "").replace(/^🏗️ Visita SSR — /, "").split("|")[0].trim(),
      phone:    info.phone || extraerTelefonoDeEvento(e.description),
      email:    info.email,
      project:  info.proyecto,
      zone:     info.zona,
    };
  });
}

// ── v18 (16 sept 2026) — NUEVO: obtener un evento puntual por su ID.
// Se usa como respaldo en confirmaciones.js: si el proceso se reinició
// entre el envío de la pregunta de confirmación (7pm) y la respuesta del
// cliente (que puede llegar horas después), la caché en memoria de ese
// módulo se pierde — esta función permite reconstruir los datos de la
// visita directamente desde Calendar usando el eventId que ya viaja en el
// ID del botón, sin depender de que el proceso siga siendo el mismo.
async function getEventById(eventId) {
  if (!eventId) return null;
  try {
    const calendar = await getCalendarClient();
    const response = await calendar.events.get({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      eventId,
    });
    return response.data;
  } catch (err) {
    console.warn(`⚠️ getEventById: no se pudo obtener el evento ${eventId}:`, err.message);
    return null;
  }
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
// ─────────────────────────────────────────────────────────────────────────────
async function createVisitEvent({ name, phone, project, zone, day, hour, wazeLink, clientEmail, skipAvailabilityCheck = false }) {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT) throw new Error("GOOGLE_SERVICE_ACCOUNT no configurado");
  if (!process.env.GOOGLE_CALENDAR_ID)     throw new Error("GOOGLE_CALENDAR_ID no configurado");

  const calendar = await getCalendarClient();

  const startDate = getNextAvailableDate(day, hour);

  if (!skipAvailabilityCheck) {
    if (!esDiaLaborable(startDate)) {
      console.warn(`⛔ createVisitEvent abortado: "${day}" cae en día NO laborable (${startDate.toLocaleDateString("es-CR", { timeZone: "America/Costa_Rica", weekday: "long" })})`);
      return {
        ok: false,
        motivo: "dia_no_laborable",
        conflicto: null,
        startDate,
      };
    }

    const dispo = await verificarDisponibilidadExacta(startDate, phone);
    if (!dispo.disponible) {
      console.warn(`⛔ createVisitEvent abortado: ${dispo.motivo} (${dispo.conflicto || "—"})`);
      return {
        ok: false,
        motivo: dispo.motivo,
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
  listVisitsForDate,
  getEventById,
  esDiaLaborable,
  proximosDiasHabiles,
};
