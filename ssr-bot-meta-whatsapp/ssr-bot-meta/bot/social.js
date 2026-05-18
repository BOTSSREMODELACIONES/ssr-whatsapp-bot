/**
 * social.js — Automatización Facebook Messenger + Instagram
 * SS Remodelaciones — Sasha Bot
 *
 * Maneja:
 *  - DMs de Facebook Messenger
 *  - DMs de Instagram
 *  - Comentarios en posts de Facebook
 *  - Comentarios en posts de Instagram
 *
 * VARIABLES DE ENTORNO REQUERIDAS:
 *  FB_PAGE_ACCESS_TOKEN  — Token de la Página de Facebook (permanente)
 *  FB_PAGE_ID            — ID numérico de la Página de Facebook
 *  INSTAGRAM_ACCOUNT_ID  — ID numérico de la cuenta Instagram Business
 *
 * CÓMO OBTENERLAS:
 *  1. business.facebook.com → Configuración → Cuentas → Páginas → tu página → Info
 *  2. developers.facebook.com → tu App → Graph API Explorer
 *     GET /me?fields=id,name → FB_PAGE_ID
 *     GET /me/instagram_accounts → INSTAGRAM_ACCOUNT_ID
 *  3. Token permanente: business.facebook.com → System Users → Generate Token
 *     Permisos: pages_messaging, instagram_basic, instagram_manage_messages,
 *               pages_read_engagement, pages_manage_engagement
 *
 * CONFIGURAR WEBHOOK EN META:
 *  developers.facebook.com → tu App → Webhooks
 *  Agregar suscripciones:
 *  - Page:      messages, messaging_postbacks, feed
 *  - Instagram: messages, comments
 *  Callback URL: https://tu-bot.railway.app/webhook  (mismo que WhatsApp)
 */

const { ask }    = require("./claude");
const { get, update, addMsg } = require("./state");
const memoria    = require("./memoria");

const GRAPH_URL = "https://graph.facebook.com/v19.0";

// ── Supervisores (misma lista que index.js) ───────────────────────────────────
const SUPERVISORES_WA = [
  "+50683091817", "+50670068477", "+50671981370", "+50662052075",
];

// ── Enviar mensaje por Facebook Messenger ─────────────────────────────────────
async function sendFBMessage(recipientId, text) {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error("FB_PAGE_ACCESS_TOKEN no configurado");

  const res = await fetch(`${GRAPH_URL}/me/messages`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body:    JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`FB API error: ${data?.error?.message || res.status}`);
  return data;
}

// ── Enviar mensaje por Instagram DM ──────────────────────────────────────────
async function sendIGMessage(recipientId, text) {
  const token     = process.env.FB_PAGE_ACCESS_TOKEN;
  const igAccount = process.env.INSTAGRAM_ACCOUNT_ID;
  if (!token || !igAccount) throw new Error("FB_PAGE_ACCESS_TOKEN o INSTAGRAM_ACCOUNT_ID no configurado");

  const res = await fetch(`${GRAPH_URL}/${igAccount}/messages`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body:    JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`IG API error: ${data?.error?.message || res.status}`);
  return data;
}

// ── Responder comentario de Facebook ─────────────────────────────────────────
async function replyFBComment(commentId, text) {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error("FB_PAGE_ACCESS_TOKEN no configurado");

  const res = await fetch(`${GRAPH_URL}/${commentId}/comments`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body:    JSON.stringify({ message: text }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`FB comment reply error: ${data?.error?.message || res.status}`);
  return data;
}

// ── Responder comentario de Instagram ─────────────────────────────────────────
async function replyIGComment(commentId, text) {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error("FB_PAGE_ACCESS_TOKEN no configurado");

  const res = await fetch(`${GRAPH_URL}/${commentId}/replies`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body:    JSON.stringify({ message: text }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`IG comment reply error: ${data?.error?.message || res.status}`);
  return data;
}

// ── Generar respuesta para comentario público ─────────────────────────────────
/**
 * Los comentarios son públicos → respuesta breve, profesional,
 * que invite a escribir por DM para no dar precios en público.
 */
async function generarRespuestaComentario(comentario, nombreUsuario, plataforma) {
  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await anthropic.messages.create({
      model:      "claude-sonnet-4-5",
      max_tokens: 150,
      system: `Sos Sasha, asistente de SS Remodelaciones (empresa de remodelaciones y construcción en Costa Rica).
Respondés comentarios públicos en ${plataforma === "instagram" ? "Instagram" : "Facebook"}.

REGLAS ESTRICTAS para comentarios públicos:
- Respuesta MUY corta (máximo 2 oraciones)
- Nunca menciones precios en comentarios públicos
- Siempre invitá a escribir por mensaje directo (DM) para más información
- Tono amigable, cálido, profesional
- Usá emojis con moderación (1-2 máximo)
- Si es una consulta técnica, invitá a DM
- Si es un elogio, agradecé brevemente
- Si es una queja, disculpate brevemente e invitá a DM

Ejemplos:
- "¡Gracias por tu interés! 😊 Escribinos por mensaje directo para darte todos los detalles."
- "¡Hola! Con gusto te ayudamos. Escribinos por DM para coordinar una visita sin costo."`,
      messages: [{
        role:    "user",
        content: `${nombreUsuario ? `Usuario: ${nombreUsuario}\n` : ""}Comentario: "${comentario}"\n\nGenerá la respuesta pública.`,
      }],
    });

    return response.content[0]?.text?.trim() ||
      "¡Hola! Gracias por escribirnos 😊 Envianos un mensaje directo para darte toda la información.";
  } catch (err) {
    console.error("❌ Social: error generando respuesta comentario:", err.message);
    return "¡Hola! Gracias por tu comentario 😊 Escribinos por DM para más información sobre nuestros servicios.";
  }
}

// ── Manejar DM de Facebook Messenger ─────────────────────────────────────────
async function handleFBDM(senderId, text, senderName) {
  if (!text || !text.trim()) return;

  // ID prefijado para no colisionar con WhatsApp en state.js
  const platformId = `fb_${senderId}`;
  const session    = get(platformId);

  if (session.escalated) return;

  const historyText = text.trim();
  addMsg(platformId, "user", historyText);

  // Guardar en memoria
  memoria.guardarMensaje({
    phone:      `fb_${senderId}`,
    clientName: senderName || senderId,
    direction:  "in",
    type:       "text",
    content:    historyText,
    session,
  }).catch(() => {});

  console.log(`💬 FB Messenger de ${senderName || senderId}: "${text.substring(0, 60)}"`);

  try {
    const rawResponse = await ask(session.history.slice(0, -1), historyText, null);

    // Limpiar flags (no aplican en FB, solo en WhatsApp)
    const cleanMessage = rawResponse
      .replace(/\[(ESCALAR|LEAD:[^\]]*|VISITA:[^\]]*|SOLICITANTE|PROVEEDOR)\]\s*$/g, "")
      .replace(/\[SISTEMA:[\s\S]*?\]/g, "")
      .trim();

    await sendFBMessage(senderId, cleanMessage);
    addMsg(platformId, "assistant", cleanMessage);

    memoria.guardarMensaje({
      phone:      `fb_${senderId}`,
      clientName: senderName || senderId,
      direction:  "out",
      type:       "text",
      content:    cleanMessage,
      session,
    }).catch(() => {});

    // Notificar a supervisores por WhatsApp
    const { sendText } = require("./messenger");
    const monitorMsg =
      `💙 *FB Messenger — Conversación en tiempo real*\n` +
      `👤 ${senderName || `ID: ${senderId}`}\n\n` +
      `💬 *Cliente:* ${text}\n` +
      `🤖 *Sasha:* ${cleanMessage}`;
    for (const sup of SUPERVISORES_WA) {
      sendText(sup, monitorMsg).catch(() => {});
    }

  } catch (err) {
    console.error("❌ Social: error respondiendo FB DM:", err.message);
    await sendFBMessage(senderId,
      "Hola, gracias por escribirnos. En este momento tenemos un inconveniente técnico. " +
      "Por favor escribinos directamente al WhatsApp de SS Remodelaciones."
    ).catch(() => {});
  }
}

// ── Manejar DM de Instagram ───────────────────────────────────────────────────
async function handleIGDM(senderId, text, senderName) {
  if (!text || !text.trim()) return;

  const platformId = `ig_${senderId}`;
  const session    = get(platformId);

  if (session.escalated) return;

  const historyText = text.trim();
  addMsg(platformId, "user", historyText);

  memoria.guardarMensaje({
    phone:      `ig_${senderId}`,
    clientName: senderName || senderId,
    direction:  "in",
    type:       "text",
    content:    historyText,
    session,
  }).catch(() => {});

  console.log(`📸 Instagram DM de ${senderName || senderId}: "${text.substring(0, 60)}"`);

  try {
    const rawResponse = await ask(session.history.slice(0, -1), historyText, null);

    const cleanMessage = rawResponse
      .replace(/\[(ESCALAR|LEAD:[^\]]*|VISITA:[^\]]*|SOLICITANTE|PROVEEDOR)\]\s*$/g, "")
      .replace(/\[SISTEMA:[\s\S]*?\]/g, "")
      .trim();

    await sendIGMessage(senderId, cleanMessage);
    addMsg(platformId, "assistant", cleanMessage);

    memoria.guardarMensaje({
      phone:      `ig_${senderId}`,
      clientName: senderName || senderId,
      direction:  "out",
      type:       "text",
      content:    cleanMessage,
      session,
    }).catch(() => {});

    const { sendText } = require("./messenger");
    const monitorMsg =
      `🟣 *Instagram DM — Conversación en tiempo real*\n` +
      `👤 ${senderName || `ID: ${senderId}`}\n\n` +
      `💬 *Cliente:* ${text}\n` +
      `🤖 *Sasha:* ${cleanMessage}`;
    for (const sup of SUPERVISORES_WA) {
      sendText(sup, monitorMsg).catch(() => {});
    }

  } catch (err) {
    console.error("❌ Social: error respondiendo IG DM:", err.message);
    await sendIGMessage(senderId,
      "Hola, gracias por escribirnos. Tuvimos un problema técnico momentáneo. " +
      "Por favor escribinos al WhatsApp de SS Remodelaciones para atenderte de inmediato."
    ).catch(() => {});
  }
}

// ── Manejar comentario de Facebook ────────────────────────────────────────────
async function handleFBComment(commentId, texto, userName, postId) {
  if (!texto || !texto.trim()) return;

  // Ignorar comentarios de la propia página para evitar loops
  const fbPageId = process.env.FB_PAGE_ID;
  console.log(`💬 FB Comentario de ${userName}: "${texto.substring(0, 60)}"`);

  try {
    const respuesta = await generarRespuestaComentario(texto, userName, "facebook");
    await replyFBComment(commentId, respuesta);
    console.log(`✅ FB: comentario respondido para ${userName}`);

    // Notificar supervisores
    const { sendText } = require("./messenger");
    const notif =
      `💙 *Nuevo comentario en Facebook*\n` +
      `👤 ${userName}\n` +
      `💬 "${texto}"\n` +
      `🤖 Sasha respondió: "${respuesta}"`;
    for (const sup of SUPERVISORES_WA) {
      sendText(sup, notif).catch(() => {});
    }

    // Guardar en memoria
    memoria.guardarMensaje({
      phone:      `fb_comment_${postId}`,
      clientName: userName,
      direction:  "in",
      type:       "text",
      content:    `[FB Comentario] ${texto}`,
    }).catch(() => {});

  } catch (err) {
    console.error("❌ Social: error respondiendo comentario FB:", err.message);
  }
}

// ── Manejar comentario de Instagram ──────────────────────────────────────────
async function handleIGComment(commentId, texto, userId, mediaId) {
  if (!texto || !texto.trim()) return;

  // Ignorar comentarios propios (de la cuenta de negocio)
  const igAccountId = process.env.INSTAGRAM_ACCOUNT_ID;
  if (userId === igAccountId) return;

  console.log(`📸 IG Comentario (${userId}): "${texto.substring(0, 60)}"`);

  try {
    const respuesta = await generarRespuestaComentario(texto, null, "instagram");
    await replyIGComment(commentId, respuesta);
    console.log(`✅ IG: comentario respondido`);

    const { sendText } = require("./messenger");
    const notif =
      `🟣 *Nuevo comentario en Instagram*\n` +
      `👤 ID: ${userId}\n` +
      `💬 "${texto}"\n` +
      `🤖 Sasha respondió: "${respuesta}"`;
    for (const sup of SUPERVISORES_WA) {
      sendText(sup, notif).catch(() => {});
    }

    memoria.guardarMensaje({
      phone:      `ig_comment_${mediaId}`,
      clientName: userId,
      direction:  "in",
      type:       "text",
      content:    `[IG Comentario] ${texto}`,
    }).catch(() => {});

  } catch (err) {
    console.error("❌ Social: error respondiendo comentario IG:", err.message);
  }
}

module.exports = {
  sendFBMessage,
  sendIGMessage,
  replyFBComment,
  replyIGComment,
  handleFBDM,
  handleIGDM,
  handleFBComment,
  handleIGComment,
};
