/**
 * outbound.js — Mensajes Proactivos / Salientes
 * SS Remodelaciones — Sasha Bot
 *
 * Permite a Darwin, Melvin y Jessy ordenarle a Sasha que contacte
 * a un cliente sin que este haya escrito primero.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RESTRICCIÓN DE META (importante):
 * Fuera de la ventana de 24h desde el último mensaje del cliente,
 * Meta solo acepta Message Templates aprobados (HSM).
 * Este módulo detecta la ventana automáticamente y usa el método correcto.
 *
 * TEMPLATE REQUERIDO (crear en Meta Business Manager):
 *  Nombre:    ssr_mensaje_general
 *  Categoría: UTILITY
 *  Idioma:    es
 *  Cuerpo:    {{1}}
 *  Pie:       SS Remodelaciones
 *
 *  Crear en: business.facebook.com → Cuenta WhatsApp → Plantillas de mensajes
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * COMANDOS DISPONIBLES (desde WhatsApp de cualquier admin):
 *  enviar a +50688887777: [mensaje]
 *  enviar a María González: [mensaje]
 *  mensaje para +506XXXXXXXX: [mensaje]
 *  contactar +50688887777: [mensaje]
 *  avisar a Juan Pérez: [mensaje]
 *  dile a Carlos: [mensaje]
 *
 * ENDPOINT HTTP (para Make / n8n):
 *  POST /api/outbound
 *  Headers: x-outbound-token: [OUTBOUND_SECRET]
 *  Body: { "to": "+50688887777", "message": "..." }
 *        { "nombre": "María González", "message": "..." }
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
        console.log(`✅ Outbound [texto libre fallback] → ${toE164}`);
        return { ok: true, method: "free_text_fallback" };
      }
    }
  } catch (err) {
    console.error(`❌ Outbound error → ${toE164}:`, err.message);
    return { ok: false, error: err.message };
  }
}

async function resolverTelefono(nombreOTelefono) {
  const clean      = (nombreOTelefono || "").trim();
  const soloDigitos = clean.replace(/\D/g, "");
  if (soloDigitos.length >= 8) return limpiarTelefono(clean);

  try {
    const rows = await memoria.buscarPorNombre(clean, 5);
    if (rows && rows.length > 0 && rows[0][1]) {
      console.log(`🔍 Outbound MENSAJES: "${clean}" → ${rows[0][1]}`);
      return limpiarTelefono(rows[0][1]);
    }

    const clientes   = await memoria.listarClientes();
    const normalizado = clean.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const match = clientes.find(r => {
      const nombre = (r[1] || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      return nombre.includes(normalizado) || normalizado.includes((nombre.split(" ")[0] || ""));
    });
    if (match) {
      console.log(`🔍 Outbound CLIENTES: "${clean}" → ${match[0]}`);
      return limpiarTelefono(match[0]);
    }
  } catch (err) {
    console.warn("⚠️ Outbound: error buscando en memoria:", err.message);
  }
  return null;
}

function parsearComandoOutbound(text) {
  const PATRONES = [
    /^(?:enviar\s+a|mensaje\s+para|contactar|escribir\s+a|escrib[ií]le?\s+a)\s+(.+?):\s*(.+)/is,
    /^(?:avisar\s+a|av[íi]sale?\s+a|notific(?:ar\s+a|a)\s+)\s*(.+?):\s*(.+)/is,
    /^(?:dile?\s+a|dec[ií]le?\s+a)\s+(.+?):\s*(.+)/is,
  ];
  for (const patron of PATRONES) {
    const match = text.trim().match(patron);
    if (match) return { destino: match[1].trim(), mensaje: match[2].trim() };
  }
  return null;
}

async function procesarComandoOutbound(commandText) {
  const parsed = parsearComandoOutbound(commandText);
  if (!parsed) return null;

  const { destino, mensaje } = parsed;
  const telefono = await resolverTelefono(destino);

  if (!telefono) {
    return (
      `❌ No encontré a *"${destino}"* en la memoria de clientes.\n\n` +
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
