// Envío de mensajes vía Meta WhatsApp Business API
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/messages

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
    return false; // No es crítico si falla
  }
}

// ── Internal ─────────────────────────────────────────────────────────────────

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
    console.error(`❌ Meta API error (${res.status}):`, JSON.stringify(data));
    throw new Error(`Meta API error: ${data?.error?.message || res.status}`);
  }

  return data;
}

module.exports = { sendText, sendButtons, sendList, markRead };
