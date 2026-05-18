// messenger.js — Envío de mensajes vía Meta WhatsApp Business API
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/messages
// ─────────────────────────────────────────────────────────────────────────────
// CHANGELOG v2:
//   + sendTemplate() — mensajes fuera de ventana 24h (HSM/plantillas aprobadas)
// ─────────────────────────────────────────────────────────────────────────────

const GRAPH_URL = "https://graph.facebook.com/v19.0";

/**
 * Envía un mensaje de texto simple
 */
async function sendText(to, text) {
  return _post(to, {
    type: "text",
    text: { body: text, preview_url: false },
  });
}

/**
 * Envía un mensaje con botones de respuesta rápida (hasta 3 botones)
 * buttons: [{ id: "btn_1", title: "Opción 1" }, ...]
 */
async function sendButtons(to, bodyText, buttons, headerText = null) {
  const interactive = {
    type: "button",
    body: { text: bodyText },
    action: {
      buttons: buttons.map((b) => ({
        type: "reply",
        reply: { id: b.id, title: b.title },
      })),
    },
  };
  if (headerText) {
    interactive.header = { type: "text", text: headerText };
  }
  return _post(to, { type: "interactive", interactive });
}

/**
 * Envía lista de opciones (hasta 10 items)
 * sections: [{ title: "Sección", rows: [{ id, title, description }] }]
 */
async function sendList(to, bodyText, buttonLabel, sections) {
  return _post(to, {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText },
      action: { button: buttonLabel, sections },
    },
  });
}

/**
 * Envía un Message Template (HSM) aprobado por Meta.
 * OBLIGATORIO para contactar clientes que no escribieron en las últimas 24h.
 *
 * @param {string} to           - Teléfono destino (con +)
 * @param {string} templateName - Nombre exacto del template en Meta (ej: "ssr_mensaje_general")
 * @param {string} languageCode - Código de idioma (ej: "es", "en_US")
 * @param {Array}  components   - Parámetros del template
 *
 * Ejemplo para template con variable {{1}} en el body:
 * sendTemplate("+50688887777", "ssr_mensaje_general", "es", [
 *   { type: "body", parameters: [{ type: "text", text: "Tu mensaje aquí" }] }
 * ])
 *
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/messages/template-messages
 */
async function sendTemplate(to, templateName, languageCode = "es", components = []) {
  const payload = {
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
    },
  };
  if (components && components.length > 0) {
    payload.template.components = components;
  }
  return _post(to, payload);
}

/**
 * Reenvía una imagen/audio/video usando el Media ID de Meta
 * (no requiere re-subir el archivo, usa el ID que ya está en Meta)
 * @param {string} to      - número destino
 * @param {string} mediaId - Media ID recibido en el webhook
 * @param {string} type    - "image" | "audio" | "video" | "document"
 * @param {string} caption - (opcional) texto debajo de la imagen
 */
async function sendMediaById(to, mediaId, type = "image", caption = null) {
  const mediaPayload = { id: mediaId };
  if (caption && type === "image") mediaPayload.caption = caption;
  return _post(to, { type, [type]: mediaPayload });
}

/**
 * Descarga una imagen/media de Meta y la retorna en base64
 * @param {string} mediaId - ID del media recibido en el webhook
 * @returns {{ base64: string, mimeType: string }}
 */
async function downloadMedia(mediaId) {
  const token = process.env.WHATSAPP_TOKEN;

  const metaRes = await fetch(`${GRAPH_URL}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaRes.ok) {
    throw new Error(`Error obteniendo URL de media: ${metaRes.status}`);
  }
  const { url, mime_type } = await metaRes.json();

  const imgRes = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!imgRes.ok) {
    throw new Error(`Error descargando imagen: ${imgRes.status}`);
  }

  const buffer = Buffer.from(await imgRes.arrayBuffer());
  return {
    base64: buffer.toString("base64"),
    mimeType: mime_type || "image/jpeg",
  };
}

/**
 * Marca un mensaje como leído (muestra los dos ticks azules)
 */
async function markRead(messageId) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  try {
    const res = await fetch(`${GRAPH_URL}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Internal ──────────────────────────────────────────────────────────────────
async function _post(to, messageFields) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;

  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: to.replace(/^\+/, ""), // Meta no quiere el + al inicio
    ...messageFields,
  };

  const res = await fetch(`${GRAPH_URL}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    const err = new Error(`Meta API error: ${data?.error?.message || res.status}`);
    err.status = res.status;
    err.meta   = data?.error;
    console.error(`❌ Meta API error (${res.status}):`, JSON.stringify(data));
    throw err;
  }
  return data;
}

module.exports = { sendText, sendButtons, sendList, sendTemplate, markRead, downloadMedia, sendMediaById };
