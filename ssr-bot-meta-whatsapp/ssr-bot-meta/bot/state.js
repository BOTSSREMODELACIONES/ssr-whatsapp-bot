// Manejo de estado por conversación (en memoria — reemplazable por Redis/DB)

const sessions = new Map();

const STAGE = {
  NEW:              "new",
  ACTIVE:           "active",
  // Flujo de agendamiento de visita
  VISIT_NAME:       "visit_name",
  VISIT_PROJECT:    "visit_project",
  VISIT_ZONE:       "visit_zone",
  VISIT_DATETIME:   "visit_datetime",
  VISIT_CONFIRMING: "visit_confirming",
  VISIT_PENDING_PAY:"visit_pending_pay",
  VISIT_CONFIRMED:  "visit_confirmed",
  // Escalado a humano
  ESCALATED:        "escalated",
};

function get(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      phone,
      stage: STAGE.NEW,
      // Datos del cliente
      name: null,
      project_desc: null,
      zone: null,
      // Datos de la visita agendada
      visit_date: null,
      visit_time: null,
      // Control interno
      history: [],
      lead_saved: false,
      escalated: false,
      visit_confirmed: false,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
  }
  return sessions.get(phone);
}

function update(phone, changes) {
  const s = get(phone);
  Object.assign(s, changes, { updated_at: Date.now() });
  sessions.set(phone, s);
  return s;
}

function addMsg(phone, role, content) {
  const s = get(phone);
  s.history.push({ role, content });
  // Mantener últimos 24 mensajes
  if (s.history.length > 24) s.history = s.history.slice(-24);
  s.updated_at = Date.now();
  sessions.set(phone, s);
}

function reset(phone) {
  sessions.delete(phone);
}

// Limpieza de sesiones inactivas (>24h)
setInterval(() => {
  const cutoff = Date.now() - 86_400_000;
  for (const [phone, s] of sessions) {
    if (s.updated_at < cutoff) sessions.delete(phone);
  }
}, 3_600_000);

module.exports = { get, update, addMsg, reset, STAGE };
