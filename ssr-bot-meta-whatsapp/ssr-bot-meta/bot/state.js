/**
 * state.js — Estado de conversaciones para Sasha
 * SS Remodelaciones
 *
 * v2: Persistencia en disco — las sesiones sobreviven reinicios de Railway.
 * El archivo sessions.json se guarda en /tmp (disponible en Railway entre
 * reinicios del proceso, pero NO entre re-deploys de código).
 * Para reinicios normales por inactividad: cubre el 95% de los casos.
 */

const fs   = require("fs");
const path = require("path");

const SESSIONS_FILE = path.join("/tmp", "sasha_sessions.json");
const MAX_HISTORY   = 30;  // máximo mensajes por conversación
const SESSION_TTL   = 24 * 60 * 60 * 1000; // 24 horas en ms — sesiones viejas se limpian

// ── Cargar sesiones desde disco al arrancar ───────────────────────────────────
let sessions = new Map();

function cargarSesiones() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const raw  = fs.readFileSync(SESSIONS_FILE, "utf8");
      const data = JSON.parse(raw);
      const ahora = Date.now();
      let cargadas = 0;
      let expiradas = 0;

      for (const [phone, session] of Object.entries(data)) {
        const ultimaActividad = session._lastActivity || 0;
        if (ahora - ultimaActividad < SESSION_TTL) {
          sessions.set(phone, session);
          cargadas++;
        } else {
          expiradas++;
        }
      }

      console.log(`✅ State: ${cargadas} sesiones restauradas, ${expiradas} expiradas ignoradas`);
    } else {
      console.log("📝 State: sin sesiones previas, arrancando fresco");
    }
  } catch (err) {
    console.warn("⚠️ State: no se pudieron cargar sesiones:", err.message);
    sessions = new Map();
  }
}

// ── Guardar sesiones en disco (async, no bloquea el flujo) ───────────────────
let _saveTimer = null;
function persistirSesiones() {
  if (_saveTimer) return; // ya hay un save pendiente
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      const data = {};
      for (const [phone, session] of sessions.entries()) {
        data[phone] = session;
      }
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data), "utf8");
    } catch (err) {
      console.warn("⚠️ State: no se pudo persistir sesiones:", err.message);
    }
  }, 500); // debounce 500ms — agrupa múltiples writes
}

// ── API pública ───────────────────────────────────────────────────────────────
function defaultSession() {
  return {
    history:         [],
    name:            null,
    project_desc:    null,
    zone:            null,
    visit_day:       null,
    visit_hour:      null,
    waze_link:       null,
    client_email:    null,
    visit_confirmed: false,
    lead_saved:      false,
    escalated:       false,
    slots_shown:     null,
    modo:            null,
    rrhh_paso:       0,
    rrhh_data:       {},
    _lastActivity:   Date.now(),
  };
}

function get(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, defaultSession());
  }
  return sessions.get(phone);
}

function update(phone, fields) {
  const session = get(phone);
  Object.assign(session, fields, { _lastActivity: Date.now() });
  sessions.set(phone, session);
  persistirSesiones();
  return session;
}

function addMsg(phone, role, content) {
  const session = get(phone);
  session.history.push({ role, content });
  if (session.history.length > MAX_HISTORY) {
    session.history = session.history.slice(-MAX_HISTORY);
  }
  session._lastActivity = Date.now();
  sessions.set(phone, session);
  persistirSesiones();
}

function reset(phone) {
  sessions.set(phone, defaultSession());
  persistirSesiones();
  console.log(`🔄 State: sesión reseteada para ${phone}`);
}

// ── Limpiar sesiones expiradas cada 6 horas ───────────────────────────────────
function limpiarSesionesViejas() {
  const ahora = Date.now();
  let eliminadas = 0;
  for (const [phone, session] of sessions.entries()) {
    if (ahora - (session._lastActivity || 0) > SESSION_TTL) {
      sessions.delete(phone);
      eliminadas++;
    }
  }
  if (eliminadas > 0) {
    console.log(`🧹 State: ${eliminadas} sesiones expiradas eliminadas`);
    persistirSesiones();
  }
}
setInterval(limpiarSesionesViejas, 6 * 60 * 60 * 1000);

// ── Arrancar: cargar sesiones existentes ─────────────────────────────────────
cargarSesiones();

module.exports = { get, update, addMsg, reset };
