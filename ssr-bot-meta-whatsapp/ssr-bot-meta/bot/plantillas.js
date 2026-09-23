/**
 * ============================================================
 * plantillas.js — Envío de PLANTILLAS aprobadas de WhatsApp
 * SS Remodelaciones — Sasha Bot
 * ============================================================
 *
 * POR QUÉ EXISTE (23 sept 2026)
 * WhatsApp solo entrega mensajes de texto libre (o con botones
 * interactivos) si el cliente escribió en las últimas 24 horas. Los
 * mensajes que Sasha manda POR INICIATIVA PROPIA —confirmación de
 * visita de las 7 p.m., recordatorio de las 8 a.m.— casi siempre caen
 * fuera de esa ventana (el cliente agendó días antes), así que Meta
 * los aceptaba con "OK" y después no los entregaba (error 131047).
 * Fuera de la ventana SOLO se entregan plantillas aprobadas.
 *
 * CONFIGURACIÓN (Railway → Variables), formato "nombre|idioma":
 *   WA_PLANTILLA_CONFIRMACION_VISITA = confirmacion_visita|es_CR
 *   WA_PLANTILLA_RECORDATORIO_VISITA = recordatorio_visita|es_CR
 *   WA_PLANTILLA_REAPERTURA          = reabrir_conversacion|es_CR  (usada por server.js)
 *
 * Si una variable no está configurada, el módulo que la usa vuelve a
 * su comportamiento anterior (texto libre), que solo llega a clientes
 * con la ventana de 24 h abierta.
 * ============================================================
 */

const WA_API_VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";

// Lee "nombre|idioma" de una variable de entorno. null si no está.
function plantillaConfigurada(nombreVariable) {
  const conf = String(process.env[nombreVariable] || "").trim();
  if (!conf) return null;
  const [nombre, idioma] = conf.split("|").map(s => (s || "").trim());
  if (!nombre) return null;
  return { nombre, idioma: idioma || "es" };
}

// Meta rechaza parámetros vacíos o con saltos de línea, tabulaciones o
// más de 4 espacios seguidos (error 132018). Se limpian acá.
function limpiarParametro(valor, porDefecto) {
  const t = String(valor === null || valor === undefined ? "" : valor)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return t || porDefecto || "-";
}

/**
 * Envía la plantilla configurada en `nombreVariable`.
 *   cuerpo          → valores para {{1}}, {{2}}, … del cuerpo, en orden.
 *   botonesPayload  → payload de cada botón de respuesta rápida, en orden
 *                     (lo que WhatsApp devuelve cuando el cliente lo toca).
 * Devuelve { ok: true, id, plantilla }. Lanza Error si Meta la rechaza.
 */
async function enviarPlantilla(telefono, nombreVariable, { cuerpo = [], botonesPayload = [] } = {}) {
  const plantilla = plantillaConfigurada(nombreVariable);
  if (!plantilla) throw new Error(`La variable ${nombreVariable} no está configurada en Railway.`);

  const to = String(telefono || "").replace(/\D/g, "");
  if (!to) throw new Error("Teléfono vacío.");

  const components = [];

  if (cuerpo.length) {
    components.push({
      type: "body",
      parameters: cuerpo.map(v => ({ type: "text", text: limpiarParametro(v) })),
    });
  }

  botonesPayload.forEach((payload, i) => {
    components.push({
      type: "button",
      sub_type: "quick_reply",
      index: String(i),
      parameters: [{ type: "payload", payload: String(payload) }],
    });
  });

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: plantilla.nombre,
      language: { code: plantilla.idioma },
      ...(components.length ? { components } : {}),
    },
  };

  const r = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    const e = data?.error || {};
    const detalle = e.error_data?.details ? ` · ${e.error_data.details}` : "";
    throw new Error(`Plantilla "${plantilla.nombre}" rechazada por Meta [${e.code || r.status}] ${e.message || ""}${detalle}`);
  }

  return { ok: true, id: data?.messages?.[0]?.id || null, plantilla: plantilla.nombre };
}

module.exports = {
  plantillaConfigurada,
  enviarPlantilla,
  limpiarParametro,
};
