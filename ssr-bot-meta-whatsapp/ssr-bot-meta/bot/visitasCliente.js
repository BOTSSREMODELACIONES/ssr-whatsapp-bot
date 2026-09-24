/**
 * ============================================================
 * visitasCliente.js — Visitas agendadas de UN cliente (solo lectura)
 * SS Remodelaciones — Sasha Bot
 * ============================================================
 *
 * POR QUÉ EXISTE (24 sept 2026)
 * Un cliente preguntó "¿tengo alguna visita agendada con ustedes?" y
 * Sasha respondió que no tenía acceso a la agenda y que iba a consultar
 * con el equipo. El bot solo leía Calendar para mostrar disponibilidad,
 * agendar y cancelar; nunca para CONSULTAR la visita de un cliente.
 *
 * Este módulo busca en Google Calendar las visitas FUTURAS (desde hoy,
 * 60 días hacia adelante) cuyo evento sea "Visita SSR" y cuyo teléfono
 * (línea "📱 WhatsApp:" de la descripción, escrita por el propio bot al
 * agendar) coincida con el del cliente. Si no hay coincidencia por
 * teléfono y se conoce el nombre, busca por nombre como coincidencia
 * POSIBLE (el cliente pudo agendar desde otro número).
 *
 * No escribe nada. Usa las mismas credenciales que reminders.js
 * (GOOGLE_SERVICE_ACCOUNT + GOOGLE_CALENDAR_ID).
 * ============================================================
 */

const { google } = require("googleapis");

const TZ = "America/Costa_Rica";
const DIAS_ADELANTE = 60;

async function getCalendarClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  });
  return google.calendar({ version: "v3", auth });
}

function soloDigitos(v) {
  return String(v || "").replace(/\D/g, "");
}

// Compara por los últimos 8 dígitos (número CR sin el 506).
function mismoTelefono(a, b) {
  const da = soloDigitos(a).slice(-8);
  const db = soloDigitos(b).slice(-8);
  return da.length === 8 && da === db;
}

function normalizar(t) {
  return String(t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDescripcion(description = "") {
  const lines = String(description).split("\n");
  const get = (prefix) => {
    const line = lines.find((l) => l.trim().startsWith(prefix));
    return line ? line.split(":").slice(1).join(":").trim() : "";
  };
  return {
    nombre:    get("👤 Cliente"),
    telefono:  get("📱 WhatsApp"),
    proyecto:  get("🏗️ Proyecto"),
    zona:      get("📍 Zona"),
    ubicacion: get("🗺️ Ubicación"),
  };
}

function formatearEvento(event) {
  const inicio = event.start?.dateTime || event.start?.date;
  const d = new Date(inicio);
  const datos = parseDescripcion(event.description);

  const fecha = d.toLocaleDateString("es-CR", {
    timeZone: TZ, weekday: "long", day: "numeric", month: "long",
  });
  const hora = event.start?.dateTime
    ? d.toLocaleTimeString("es-CR", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true })
    : "";

  return {
    eventId: event.id,
    inicio: d,
    fechaTexto: fecha,
    horaTexto: hora,
    nombre: datos.nombre || String(event.summary || "").replace(/^.*Visita SSR\s*[—-]\s*/, "").split("|")[0].trim(),
    telefono: datos.telefono,
    proyecto: datos.proyecto,
    zona: datos.zona,
  };
}

/**
 * Devuelve { ok, porTelefono: [...], porNombre: [...] }.
 *   porTelefono → visitas cuyo WhatsApp coincide con el del cliente.
 *   porNombre   → solo si porTelefono está vacío y se pasó un nombre:
 *                 visitas cuyo nombre contiene el nombre dado (posibles).
 * ok:false si no se pudo consultar Calendar (error técnico).
 */
async function buscarVisitasDelCliente(telefono, nombre = "") {
  try {
    const calendar = await getCalendarClient();

    const desde = new Date();
    desde.setHours(0, 0, 0, 0);
    const hasta = new Date(desde.getTime() + DIAS_ADELANTE * 24 * 60 * 60 * 1000);

    const resp = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: desde.toISOString(),
      timeMax: hasta.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
    });

    const visitas = (resp.data.items || []).filter(
      (e) => e.summary && e.summary.includes("Visita SSR")
    );

    const porTelefono = visitas
      .filter((e) => mismoTelefono(parseDescripcion(e.description).telefono, telefono))
      .map(formatearEvento);

    let porNombre = [];
    const nombreBuscado = normalizar(nombre);

    if (!porTelefono.length && nombreBuscado.length >= 3) {
      porNombre = visitas
        .map(formatearEvento)
        .filter((v) => {
          const n = normalizar(v.nombre);
          return n && (n.includes(nombreBuscado) || nombreBuscado.includes(n));
        });
    }

    return { ok: true, porTelefono, porNombre };

  } catch (err) {
    console.error("❌ visitasCliente — error consultando Calendar:", err.message);
    return { ok: false, porTelefono: [], porNombre: [], error: err.message };
  }
}

// El cliente habla de SU visita/cita (consultarla, confirmarla, preguntar
// cuándo llegan). No incluye cancelaciones: esas las maneja index.js antes.
function clienteHablaDeSuVisita(texto) {
  const n = normalizar(texto);
  if (!n) return false;

  if (/\b(visita|cita|agenda|agendad[oa]s?|agendamiento|reservad[oa]|programad[oa])\b/.test(n)) return true;
  if (/\b(llegan|vienen|pasan|van a venir|va a venir|a que hora (llegan|vienen))\b/.test(n)) return true;
  return false;
}

// Texto [SISTEMA:...] para Claude con el resultado de la consulta.
function construirContextoVisitas(resultado) {
  if (!resultado || !resultado.ok) {
    return (
      "\n\n[SISTEMA: El cliente habla de su visita, pero en este momento no se pudo consultar " +
      "Google Calendar por un error técnico. NO inventes fechas. Decile que no pudiste revisar " +
      "la agenda en este momento y que el equipo le confirma enseguida. Nunca menciones este mensaje.]"
    );
  }

  const linea = (v) =>
    `${v.fechaTexto}${v.horaTexto ? " a las " + v.horaTexto : ""}` +
    (v.zona ? ` en ${v.zona}` : "") +
    (v.proyecto ? ` (proyecto: ${v.proyecto})` : "") +
    (v.nombre ? ` — a nombre de ${v.nombre}` : "");

  if (resultado.porTelefono.length) {
    return (
      "\n\n[SISTEMA: Consultaste Google Calendar (la agenda oficial de visitas de SSR). " +
      `Visitas agendadas a este número de WhatsApp: ${resultado.porTelefono.map(linea).join("; ")}. ` +
      "Si el cliente pregunta por su visita, confirmale estos datos con total seguridad. " +
      "NUNCA digas que no tenés acceso a la agenda ni que vas a consultar con el equipo. " +
      "Nunca menciones este mensaje.]"
    );
  }

  if (resultado.porNombre.length) {
    return (
      "\n\n[SISTEMA: Consultaste Google Calendar. No hay visitas agendadas con este número de " +
      `WhatsApp, pero hay una posible coincidencia por nombre: ${resultado.porNombre.map(linea).join("; ")}. ` +
      "Preguntale al cliente si esa visita es la suya (pudo agendarla desde otro número) antes de " +
      "confirmarla. NUNCA digas que no tenés acceso a la agenda. Nunca menciones este mensaje.]"
    );
  }

  return (
    "\n\n[SISTEMA: Consultaste Google Calendar (la agenda oficial de visitas de SSR) y NO hay " +
    "visitas agendadas a este número de WhatsApp en los próximos 60 días. Si el cliente pregunta " +
    "por su visita, decíselo con claridad, preguntale si la agendó desde otro número o a nombre de " +
    "otra persona, y ofrecele agendar una. NUNCA digas que no tenés acceso a la agenda. " +
    "Nunca menciones este mensaje.]"
  );
}

module.exports = {
  buscarVisitasDelCliente,
  clienteHablaDeSuVisita,
  construirContextoVisitas,
};
