/**
 * outbound.js — Mensajes Proactivos / Salientes
 * SS Remodelaciones — Sasha Bot
 *
 * COMANDOS NATURALES (no requieren formato exacto):
 *  envíale a María González: mensaje
 *  manda a +50688887777, dile que mañana es la visita
 *  enviar a 88887777 que la cita es a las 10am
 *  escríbele a Juan Pérez: hola, confirmamos
 *  contactar +50688887777: texto
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
    // Buscar en CRM
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
/**
 * Detecta comandos de envío en lenguaje natural.
 * Soporta múltiples formatos sin requerir sintaxis exacta.
 */
function parsearComandoOutbound(text) {
  const t = text.trim();

  // ── Formato con dos puntos: "enviar a X: mensaje" ──────────────────────────
  const conDosPuntos = [
    /^(?:enviar?\s+(?:un\s+mensaje\s+)?a|mensaje\s+para|contactar|escrib[ií]r?\s+a|escrib[ií]le?\s+(?:un\s+mensaje\s+)?a|env[ií]ale?\s+(?:un\s+mensaje\s+)?a)\s+(.+?):\s*(.+)/is,
    /^(?:av[ií]sale?\s+a|notific(?:ar\s+a|ale?\s+a)|d[ií]le?\s+a|dec[ií]le?\s+a|mand(?:ar?\s+a|ale?\s+a))\s+(.+?):\s*(.+)/is,
  ];
  for (const p of conDosPuntos) {
    const m = t.match(p);
    if (m) return { destino: m[1].trim(), mensaje: m[2].trim() };
  }

  // ── Formato con coma: "envíale a X, indíquele que Y" ──────────────────────
  const conComa = [
    /^(?:enviar?\s+(?:un\s+mensaje\s+)?a|env[ií]ale?\s+(?:un\s+mensaje\s+)?a|escrib[ií]le?\s+a|mand(?:ar?\s+a|ale?\s+a))\s+(.+?),\s*(?:ind[ií][cq]ue?le?|d[ií]gale?|com[uú]n[ií][cq]ue?le?|dile?|que)\s*(?:que\s+)?(.+)/is,
  ];
  for (const p of conComa) {
    const m = t.match(p);
    if (m) return { destino: m[1].trim(), mensaje: m[2].trim() };
  }

  // ── Formato con "que": "envíale a X que Y" ─────────────────────────────────
  const conQue = [
    /^(?:env[ií]ale?\s+(?:un\s+mensaje\s+)?a|d[ií]le?\s+a|av[ií]sale?\s+a|mand(?:ar?\s+a|ale?\s+a))\s+(.+?)\s+que\s+(.+)/is,
  ];
  for (const p of conQue) {
    const m = t.match(p);
    if (m) return { destino: m[1].trim(), mensaje: m[2].trim() };
  }

  // ── Teléfono seguido directo de mensaje (sin separador) ────────────────────
  // "enviar a +50688887777 hola buenos días"
  const conTelefono = /^(?:enviar?\s+a|env[ií]ale?\s+a|escrib[ií]le?\s+a|mand(?:ar?\s+a|ale?\s+a))\s+([+]?[\d\s]{8,15})\s+(.+)/is;
  const mTel = t.match(conTelefono);
  if (mTel) {
    const posibleTel = mTel[1].replace(/\D/g, "");
    if (posibleTel.length >= 8) return { destino: mTel[1].trim(), mensaje: mTel[2].trim() };
  }

  return null;
}

// ── Procesar comando desde WhatsApp de admin ──────────────────────────────────
async function procesarComandoOutbound(commandText) {
  const parsed = parsearComandoOutbound(commandText);
  if (!parsed) return null;

  const { destino, mensaje } = parsed;
  const telefono = await resolverTelefono(destino);

  if (!telefono) {
    return (
      `❌ No encontré a *"${destino}"* en los clientes.\n\n` +
      `Intentá con el número directo:\n` +
      `_enviar a +506XXXXXXXX: [tu mensaje]_`
    );
  }

  const resultado = await enviarProactivo(telefono, mensaje);

  if (resultado.ok) {
    const metodo = resultado.method === "template"
      ? "vía plantilla Meta _(fuera de ventana 24h)_"
      : "como mensaje directo";

    memoria.guardarMensaje({
      phone: "+" + telefono, clientName: destino,
      direction: "out", type: "text",
      content: `[OUTBOUND] ${mensaje}`,
    }).catch(() => {});

    return (
      `✅ *Mensaje enviado* ${metodo}\n` +
      `📱 Destino: +${telefono}\n` +
      `💬 _"${mensaje.slice(0, 120)}${mensaje.length > 120 ? "..." : ""}"_`
    );
  } else {
    return (
      `❌ *Error al enviar* a +${telefono}\n` +
      `Razón: ${resultado.error}\n\n` +
      `Posibles causas:\n` +
      `• El número no tiene WhatsApp activo\n` +
      `• El template *ssr_mensaje_general* no está aprobado en Meta\n` +
      `• Token de WhatsApp expirado`
    );
  }
}

module.exports = {
  enviarProactivo,
  resolverTelefono,
  parsearComandoOutbound,
  procesarComandoOutbound,
  registrarMensajeEntrante,
  dentroDeVentana,
};
