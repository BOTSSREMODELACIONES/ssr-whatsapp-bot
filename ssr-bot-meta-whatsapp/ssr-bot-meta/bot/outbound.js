/**
 * outbound.js — Mensajes Proactivos / Salientes
 * SS Remodelaciones — Sasha Bot
 *
 * Sasha actúa como secretaria ejecutiva:
 * El admin da una instrucción → Sasha redacta el mensaje profesional → lo envía.
 */

const { sendText, sendTemplate } = require("./messenger");
const memoria                    = require("./memoria");

// ── Directorio interno del equipo SSR ────────────────────────────────────────
// Personal de confianza que Sasha conoce por nombre, apodo o alias.
// Se consulta ANTES del CRM para que comandos como "dile a Melvin que..."
// o "escríbele a Fercho" funcionen sin número explícito.
const EQUIPO_SSR = [
  {
    nombre:   "Melvin Zúñiga",
    telefono: "50671981370",
    alias:    ["melvin", "cuñis", "cunnis", "zuñiga", "zuniga", "melvi", "cuniz"],
    rol:      "Gerente de Proyectos",
  },
  {
    nombre:   "Jessy Zúñiga",
    telefono: "50662052075",
    alias:    ["jessy", "jesy", "jessy zuñiga", "diseñadora", "disenadora", "jessi"],
    rol:      "Diseñadora de Interiores",
  },
  {
    nombre:   "Fernando Cheves",
    telefono: "50661116467",
    alias:    ["fernando", "fercho", "fer", "cheves", "chevez", "fernando cheves", "fernando chevez"],
    rol:      "Operario",
  },
  {
    nombre:   "Mauricio",
    telefono: "50685734855",
    alias:    ["mauricio", "chollina", "cholina", "mauri", "chollinas"],
    rol:      "Operario",
  },
  {
    nombre:   "Maribel",
    telefono: "50662940617",
    alias:    ["maribel", "mari"],
    rol:      "Operaria",
  },
];

/**
 * Busca un miembro del equipo SSR por nombre o alias.
 * Normaliza acentos y mayúsculas para comparación flexible.
 * @param {string} busqueda
 * @returns {{ nombre, telefono, rol } | null}
 */
function buscarEnEquipoSSR(busqueda) {
  if (!busqueda) return null;
  const norm = busqueda.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim();

  for (const persona of EQUIPO_SSR) {
    // Coincidencia en alias
    if (persona.alias.some(a => {
      const aNorm = a.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      return norm.includes(aNorm) || aNorm.includes(norm);
    })) {
      return persona;
    }
    // Coincidencia en nombre completo normalizado
    const nombreNorm = persona.nombre.toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const primerNombre = nombreNorm.split(" ")[0];
    if (nombreNorm.includes(norm) || norm.includes(primerNombre)) {
      return persona;
    }
  }
  return null;
}

// ── Registro de últimos mensajes entrantes por cliente ────────────────────────
const _lastIncoming = new Map();

function registrarMensajeEntrante(phone) {
  const clean = limpiarTelefono(phone);
  if (clean) _lastIncoming.set(clean, new Date());
}

function dentroDeVentana(phone) {
  const clean = limpiarTelefono(phone);
  const last  = _lastIncoming.get(clean);
  if (!last) return false;
  return (Date.now() - last.getTime()) / (1000 * 60 * 60) < 23;
}

function limpiarTelefono(phone) {
  let clean = (phone || "").replace(/\D/g, "");
  if (clean.length === 8) clean = "506" + clean;
  return clean;
}

// ── Redactar mensaje profesional ──────────────────────────────────────────────
async function componerMensajeProfesional(instruccion, clientName) {
  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    response = await anthropic.messages.create({
      model:      "claude-sonnet-4-5",
      max_tokens: 300,
      system: `Sos Sasha, asistente ejecutiva de SS Remodelaciones, empresa de remodelaciones y construcción en Costa Rica.

Tu tarea es redactar mensajes de WhatsApp profesionales para enviarle a personas (clientes o personal interno).

REGLAS DE FORMATO:
- Tono: formal, cálido, respetuoso. Español costarricense.
- Si tenés el nombre de la persona, usalo al inicio (ej: "Hola Melvin," o "Estimada María,")
- El mensaje debe sonar como si viniera directamente de la empresa o del gerente
- Sé conciso: no más de 4-5 líneas
- Para personal interno (operarios, gerentes) podés usar un tono más directo y menos formal
- Siempre incluí al final: "Saludos, *SS Remodelaciones*"
- SOLO devolvé el mensaje final, sin explicaciones ni notas

REGLA CRÍTICA — FIDELIDAD A LOS DATOS:
- Reproducí EXACTAMENTE los horarios, fechas, nombres y datos que menciona la instrucción
- NUNCA agregues, cambies ni inventes horas, días, precios u otros datos
- Si la instrucción dice "4:00 o 4:30", el mensaje debe decir exactamente "4:00 o 4:30"
- Tu único trabajo es ajustar el tono y redacción, NO los datos concretos
- En caso de duda: copiá el dato exacto como lo dio el supervisor`,
      messages: [{
        role: "user",
        content: `${clientName && clientName.replace(/\D/g, "").length < 4 ? `Nombre de la persona: ${clientName}\n` : ""}Instrucción del supervisor: "${instruccion}"\n\nRedactá el mensaje WhatsApp profesional respetando EXACTAMENTE los datos mencionados.`,
      }],
    });

    const mensaje = response.content[0]?.text?.trim();
    if (mensaje && mensaje.length > 10) {
      console.log(`✍️ Mensaje redactado por Sasha: "${mensaje.slice(0, 80)}..."`);
      return mensaje;
    }
    return instruccion;
  } catch (err) {
    console.warn("⚠️ Outbound: error redactando mensaje:", err.message);
    return instruccion;
  }
}

// ── Envío proactivo ───────────────────────────────────────────────────────────
async function enviarProactivo(to, message) {
  const cleanPhone = limpiarTelefono(to);
  const toE164     = "+" + cleanPhone;

  if (!cleanPhone || cleanPhone.length < 10) return { ok: false, error: `Teléfono inválido: "${to}"` };
  if (!message || !message.trim())            return { ok: false, error: "El mensaje está vacío." };

  const enVentana = dentroDeVentana(cleanPhone);

  try {
    if (enVentana) {
      await sendText(toE164, message.trim());
      console.log(`✅ Outbound [texto libre] → ${toE164}`);
      return { ok: true, method: "free_text" };
    } else {
      try {
        await sendTemplate(toE164, "ssr_mensaje_general", "es", [
          { type: "body", parameters: [{ type: "text", text: message.trim() }] },
        ]);
        console.log(`✅ Outbound [template] → ${toE164}`);
        return { ok: true, method: "template" };
      } catch (templateErr) {
        console.warn(`⚠️ Template falló (${templateErr.message}), intentando texto libre...`);
        await sendText(toE164, message.trim());
        return { ok: true, method: "free_text_fallback" };
      }
    }
  } catch (err) {
    console.error(`❌ Outbound error → ${toE164}:`, err.message);
    return { ok: false, error: err.message };
  }
}

// ── Resolver teléfono por nombre ──────────────────────────────────────────────
async function resolverTelefono(nombreOTelefono) {
  const clean       = (nombreOTelefono || "").trim();
  const soloDigitos = clean.replace(/\D/g, "");

  // 1. Si ya es un número, retornarlo limpio
  if (soloDigitos.length >= 8) return limpiarTelefono(clean);

  // 2. Buscar primero en el equipo SSR (personal interno)
  const miembro = buscarEnEquipoSSR(clean);
  if (miembro) {
    console.log(`👤 Equipo SSR: "${clean}" → ${miembro.nombre} (${miembro.telefono})`);
    return miembro.telefono;
  }

  // 3. Buscar en memoria/CRM (clientes)
  try {
    const rows = await memoria.buscarPorNombre(clean, 5);
    if (rows && rows.length > 0 && rows[0][1]) {
      console.log(`🔍 Outbound MENSAJES: "${clean}" → ${rows[0][1]}`);
      return limpiarTelefono(rows[0][1]);
    }
    const crmRows = await memoria.buscarClienteEnCRM(clean);
    if (crmRows && crmRows.length > 0 && crmRows[0][1]) {
      console.log(`🔍 Outbound CRM: "${clean}" → ${crmRows[0][1]}`);
      return limpiarTelefono(crmRows[0][1]);
    }
  } catch (err) {
    console.warn("⚠️ Outbound: error buscando en memoria:", err.message);
  }
  return null;
}

// ── Parser de lenguaje natural ────────────────────────────────────────────────
function parsearComandoOutbound(text) {
  const t = text.trim();

  const conDosPuntos = [
    /^(?:enviar?\s+(?:un\s+mensaje\s+)?a|mensaje\s+para|contactar|escrib[ií]r?\s+a|escrib[ií]le?\s+(?:un\s+mensaje\s+)?a|env[ií]ale?\s+(?:un\s+mensaje\s+)?a)\s+(.+?):\s*(.+)/is,
    /^(?:av[ií]sale?\s+a|notific(?:ar\s+a|ale?\s+a)|d[ií]le?\s+a|dec[ií]le?\s+a|mand(?:ar?\s+a|ale?\s+a))\s+(.+?):\s*(.+)/is,
  ];
  for (const p of conDosPuntos) {
    const m = t.match(p);
    if (m) return { destino: m[1].trim(), instruccion: m[2].trim() };
  }

  const conComa = [
    /^(?:enviar?\s+(?:un\s+mensaje\s+)?a|env[ií]ale?\s+(?:un\s+mensaje\s+)?a|escrib[ií]le?\s+a|mand(?:ar?\s+a|ale?\s+a))\s+(.+?),\s*(?:ind[ií][cq]ue?le?|d[ií]gale?|com[uú]n[ií][cq]ue?le?|dile?|que)\s*(?:que\s+)?(.+)/is,
  ];
  for (const p of conComa) {
    const m = t.match(p);
    if (m) return { destino: m[1].trim(), instruccion: m[2].trim() };
  }

  const conQue = [
    /^(?:env[ií]ale?\s+(?:un\s+mensaje\s+)?a|d[ií]le?\s+a|av[ií]sale?\s+a|mand(?:ar?\s+a|ale?\s+a)|escr[ií]bele?\s+a|escr[ií]bele?\s+(?:un\s+(?:mensaje\s+)?)?a)\s+(.+?)\s+(?:y\s+)?(?:pre[gq]untale?\s+)?(?:que\s+)?(.+)/is,
  ];
  for (const p of conQue) {
    const m = t.match(p);
    if (m) return { destino: m[1].trim(), instruccion: m[2].trim() };
  }

  const conTelefono = /^(?:enviar?\s+a|env[ií]ale?\s+a|escrib[ií]le?\s+a|mand(?:ar?\s+a|ale?\s+a))\s+([+]?[\d\s]{8,15})\s+(.+)/is;
  const mTel = t.match(conTelefono);
  if (mTel) {
    const posibleTel = mTel[1].replace(/\D/g, "");
    if (posibleTel.length >= 8) return { destino: mTel[1].trim(), instruccion: mTel[2].trim() };
  }

  return null;
}

// ── Procesar comando desde WhatsApp de admin ──────────────────────────────────
async function procesarComandoOutbound(commandText) {
  const parsed = parsearComandoOutbound(commandText);
  if (!parsed) return null;

  const { destino, instruccion } = parsed;
  const telefono = await resolverTelefono(destino);

  if (!telefono) {
    // Verificar si es personal SSR para dar mensaje de error más útil
    const esEquipoSSR = EQUIPO_SSR.some(p =>
      p.alias.some(a => destino.toLowerCase().includes(a))
    );
    return (
      `❌ No encontré a *"${destino}"* en los ${esEquipoSSR ? "contactos" : "clientes"}.\n\n` +
      `Intentá con el número directo:\n` +
      `_enviar a +506XXXXXXXX: [instrucción]_`
    );
  }

  // Obtener nombre para personalizar el mensaje
  let clientName = destino;
  try {
    // Primero buscar en equipo SSR
    const miembro = buscarEnEquipoSSR(destino);
    if (miembro) {
      clientName = miembro.nombre;
    } else {
      const crmRows = await memoria.buscarClienteEnCRM(destino);
      if (crmRows && crmRows.length > 0 && crmRows[0][2]) clientName = crmRows[0][2];
    }
  } catch { /* no critical */ }

  const mensajeProfesional = await componerMensajeProfesional(instruccion, clientName);
  const resultado = await enviarProactivo(telefono, mensajeProfesional);

  if (resultado.ok) {
    const metodo = resultado.method === "template"
      ? "vía plantilla Meta _(fuera de ventana 24h)_"
      : "como mensaje directo";

    memoria.guardarMensaje({
      phone: "+" + telefono, clientName,
      direction: "out", type: "text",
      content: `[OUTBOUND] ${mensajeProfesional}`,
    }).catch(() => {});

    return (
      `✅ *Mensaje enviado* ${metodo}\n` +
      `📱 Destino: +${telefono}\n\n` +
      `📝 *Sasha redactó:*\n${mensajeProfesional}`
    );
  } else {
    return (
      `❌ *Error al enviar* a +${telefono}\n` +
      `Razón: ${resultado.error}`
    );
  }
}

module.exports = {
  enviarProactivo,
  resolverTelefono,
  componerMensajeProfesional,
  parsearComandoOutbound,
  procesarComandoOutbound,
  registrarMensajeEntrante,
  dentroDeVentana,
  EQUIPO_SSR,
  buscarEnEquipoSSR,
};
