/**
 * outbound.js — Mensajes Proactivos / Salientes
 * SS Remodelaciones — Sasha Bot
 *
 * Sasha actúa como secretaria ejecutiva:
 * El admin da una instrucción → Sasha redacta el mensaje profesional → lo envía.
 *
 * EJEMPLOS:
 *  "envíale a María que mañana es la visita a las 9am que si puede confirmar"
 *   → Sasha redacta: "Estimada María, le contactamos de SS Remodelaciones para
 *     recordarle su visita técnica programada para mañana a las 9:00 a.m.
 *     ¿Le es posible confirmarnos su asistencia? Quedamos a sus órdenes."
 *
 *  "dile a Juan que la cotización está lista y que la revise"
 *   → Sasha redacta un mensaje formal informando que la cotización está disponible.
 */

const { sendText, sendTemplate } = require("./messenger");
const memoria                    = require("./memoria");

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
/**
 * Toma la instrucción del admin y redacta un mensaje profesional
 * como si viniera directamente de SS Remodelaciones.
 *
 * @param {string} instruccion - Lo que el admin quiere comunicar (en sus palabras)
 * @param {string} clientName  - Nombre del cliente (opcional, para personalizar)
 * @returns {Promise<string>} Mensaje profesional listo para enviar
 */
async function componerMensajeProfesional(instruccion, clientName) {
  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await anthropic.messages.create({
      model:      "claude-sonnet-4-5",
      max_tokens: 300,
      system: `Sos Sasha, asistente ejecutiva de SS Remodelaciones, empresa de remodelaciones y construcción en Costa Rica.

Tu tarea es redactar mensajes de WhatsApp profesionales para enviarle a clientes.

REGLAS:
- Tono: formal, cálido, respetuoso. Español costarricense.
- Si tenés el nombre del cliente, usalo al inicio (ej: "Estimado Juan," o "Hola María,")
- El mensaje debe sonar como si viniera directamente de la empresa
- Sé conciso: no más de 4-5 líneas
- Siempre incluí al final: "Saludos, *SS Remodelaciones*"
- No pongas frases genéricas de relleno
- Si la instrucción menciona una hora, escribila como "9:00 a.m." o "3:30 p.m."
- Si menciona una fecha como "mañana" o "el lunes", mantenela así (no la cambies)
- SOLO devolvé el mensaje final, sin explicaciones ni notas`,
      messages: [{
        role: "user",
        content: `${clientName && clientName.replace(/\D/g, "").length < 4 ? `Nombre del cliente: ${clientName}\n` : ""}Instrucción del supervisor: "${instruccion}"\n\nRedactá el mensaje WhatsApp profesional.`,
      }],
    });

    const mensaje = response.content[0]?.text?.trim();
    if (mensaje && mensaje.length > 10) {
      console.log(`✍️ Mensaje redactado por Sasha: "${mensaje.slice(0, 80)}..."`);
      return mensaje;
    }
    return instruccion; // fallback si Claude falla
  } catch (err) {
    console.warn("⚠️ Outbound: error redactando mensaje:", err.message);
    return instruccion; // fallback al mensaje original
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
  if (soloDigitos.length >= 8) return limpiarTelefono(clean);

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
    /^(?:env[ií]ale?\s+(?:un\s+mensaje\s+)?a|d[ií]le?\s+a|av[ií]sale?\s+a|mand(?:ar?\s+a|ale?\s+a))\s+(.+?)\s+que\s+(.+)/is,
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
    return (
      `❌ No encontré a *"${destino}"* en los clientes.\n\n` +
      `Intentá con el número directo:\n` +
      `_enviar a +506XXXXXXXX: [instrucción]_`
    );
  }

  // Obtener nombre del cliente para personalizar el mensaje
  let clientName = destino;
  try {
    const crmRows = await memoria.buscarClienteEnCRM(destino);
    if (crmRows && crmRows.length > 0 && crmRows[0][2]) clientName = crmRows[0][2];
  } catch { /* no critical */ }

  // Redactar mensaje profesional
  const mensajeProfesional = await componerMensajeProfesional(instruccion, clientName);

  // Enviar
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
};
