/**
 * ============================================================
 * monitorSupervisores.js — Envíos de Sasha a los supervisores
 * SS Remodelaciones — Sasha Bot
 * ============================================================
 *
 * POR QUÉ EXISTE (28 sept 2026)
 * En los logs de Railway, por CADA mensaje de cliente aparecían dos
 * errores del monitor ("👁️ Conversación en tiempo real"):
 *
 * 1) +50671951695 → Meta API error (#100) Invalid parameter.
 *    Meta rechaza el envío en el acto: ese número no puede recibir
 *    mensajes de este WhatsApp Business (típicamente porque ES el
 *    propio número del bot, o no tiene WhatsApp). Se reintentaba en
 *    cada mensaje, para siempre.
 *
 * 2) +50671981370 → [131047] más de 24 h sin que ese supervisor le
 *    escriba a Sasha. WhatsApp solo entrega texto libre dentro de la
 *    ventana de 24 h; fuera de ella Meta acepta el envío y después no
 *    lo entrega. Además, cada fallo se guardaba en la memoria del CRM
 *    como si fuera un mensaje de conversación.
 *
 * QUÉ HACE AHORA
 * - Nunca le manda al número del propio bot (lo pregunta a Meta con
 *   WHATSAPP_PHONE_NUMBER_ID al arrancar).
 * - Si un número da (#100), lo pausa 12 h y lo avisa UNA vez en el log.
 * - Si un supervisor tiene la ventana de 24 h cerrada (Meta avisa
 *   131047), deja de mandarle copias hasta que ese supervisor le
 *   escriba algo a Sasha (cualquier mensaje reabre la ventana).
 * - Esos fallos de supervisores ya no se guardan en el CRM.
 * Las conversaciones completas se siguen viendo en el CRM del ERP.
 * ============================================================
 */

const WA_API_VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";
const PAUSA_INVALIDO_MS = 12 * 60 * 60 * 1000;

const ventanaCerrada = new Map();   // dígitos → timestamp en que se cerró
const pausadoHasta   = new Map();   // dígitos → timestamp
let numeroPropio     = null;        // dígitos del número del bot
let consultandoPropio = null;

const digitos = (n) => String(n || "").replace(/\D/g, "");

async function obtenerNumeroPropio() {
  if (numeroPropio !== null) return numeroPropio;
  if (consultandoPropio) return consultandoPropio;

  consultandoPropio = (async () => {
    try {
      const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
      if (!id || !process.env.WHATSAPP_TOKEN) return "";
      const r = await fetch(
        `https://graph.facebook.com/${WA_API_VERSION}/${id}?fields=display_phone_number,verified_name`,
        { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
      );
      const data = await r.json().catch(() => ({}));
      numeroPropio = digitos(data.display_phone_number);
      if (numeroPropio) {
        console.log(`📱 Número de WhatsApp del bot: +${numeroPropio} (${data.verified_name || "sin nombre"})`);
      }
    } catch (err) {
      console.warn("⚠️ No se pudo consultar el número propio del bot:", err.message);
      numeroPropio = "";
    }
    return numeroPropio;
  })();

  return consultandoPropio;
}

// Un supervisor le escribió a Sasha → su ventana de 24 h está abierta.
function registrarMensajeDeSupervisor(numero) {
  const d = digitos(numero);
  if (ventanaCerrada.delete(d)) {
    console.log(`👁️ Monitor: +${d} volvió a escribir; se reanudan las copias.`);
  }
}

// Llamado desde server.js cuando Meta avisa que no entregó un mensaje.
// Devuelve true si el número es de un supervisor (para no ensuciar el CRM).
function marcarFalloEntrega(numero, codigo, supervisores) {
  const d = digitos(numero);
  const esSup = (supervisores || []).some((s) => digitos(s) === d);
  if (!esSup) return false;

  if (String(codigo) === "131047" && !ventanaCerrada.has(d)) {
    ventanaCerrada.set(d, Date.now());
    console.warn(
      `👁️ Monitor: +${d} lleva más de 24 h sin escribirle a Sasha; WhatsApp no le entrega las copias. ` +
      `Se pausan hasta que le mande cualquier mensaje a Sasha.`
    );
  }
  return true;
}

// Envía un texto a un supervisor respetando pausas. Nunca lanza.
async function enviarASupervisor(numero, texto, sendText) {
  const d = digitos(numero);
  if (!d) return { enviado: false, motivo: "sin número" };

  const propio = await obtenerNumeroPropio();
  if (propio && d === propio) return { enviado: false, motivo: "es el número del bot" };
  if (ventanaCerrada.has(d)) return { enviado: false, motivo: "ventana 24 h cerrada" };
  if ((pausadoHasta.get(d) || 0) > Date.now()) return { enviado: false, motivo: "número inválido (pausado)" };

  try {
    await sendText(numero, texto);
    return { enviado: true };
  } catch (err) {
    const msg = String(err && err.message || err);
    if (/\(#100\)|Invalid parameter/i.test(msg)) {
      pausadoHasta.set(d, Date.now() + PAUSA_INVALIDO_MS);
      console.error(
        `❌ Monitor: WhatsApp rechaza enviar a +${d} (#100 Invalid parameter). Ese número no puede ` +
        `recibir mensajes de Sasha (¿es el número del propio bot o no tiene WhatsApp?). ` +
        `Se pausa 12 h; quitalo de SUPERVISORES en bot/index.js si no corresponde.`
      );
    } else {
      console.error(`❌ Monitor [+${d}]: ${msg}`);
    }
    return { enviado: false, motivo: msg };
  }
}

// Igual, para fotos (media ya subida a Meta).
async function enviarMediaASupervisor(numero, mediaId, tipo, caption, sendMediaById) {
  const d = digitos(numero);
  const propio = await obtenerNumeroPropio();
  if (!d || (propio && d === propio) || ventanaCerrada.has(d) || (pausadoHasta.get(d) || 0) > Date.now()) return;
  try {
    await sendMediaById(numero, mediaId, tipo, caption);
  } catch (err) {
    console.error(`❌ Monitor foto [+${d}]: ${err.message}`);
  }
}

function estadoMonitor() {
  return {
    numeroPropio,
    ventanaCerrada: [...ventanaCerrada.keys()].map((d) => "+" + d),
    pausados: [...pausadoHasta.entries()]
      .filter(([, t]) => t > Date.now())
      .map(([d, t]) => ({ numero: "+" + d, hasta: new Date(t).toISOString() })),
  };
}

// Consulta el número propio apenas carga el módulo (no bloquea).
obtenerNumeroPropio().catch(() => {});

module.exports = {
  enviarASupervisor,
  enviarMediaASupervisor,
  registrarMensajeDeSupervisor,
  marcarFalloEntrega,
  estadoMonitor,
};
