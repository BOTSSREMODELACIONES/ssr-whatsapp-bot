require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const path = require("path");
const { handleMessage } = require("./bot/index");
const { sendDailyReminders } = require("./bot/reminders");

const app = express();

// ── CORS — permite llamadas desde el cotizador (Claude artifacts, web) ────────
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;

const REQUIRED = [
  "WHATSAPP_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WEBHOOK_VERIFY_TOKEN",
  "ANTHROPIC_API_KEY",
];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("❌ Variables faltantes:", missing.join(", "));
  process.exit(1);
}

// ── Cron: recordatorios diarios a las 8:00 AM hora Costa Rica ────────────────
cron.schedule(
  "0 8 * * *",
  async () => {
    console.log("⏰ Cron activado — enviando recordatorios del día...");
    await sendDailyReminders();
  },
  { timezone: "America/Costa_Rica" }
);
console.log("✅ Cron de recordatorios registrado (8:00 AM CR diario)");

// ─────────────────────────────────────────────────────────────────────────────
// BUFFER DE MENSAJES — agrupa fotos múltiples del mismo cliente en un solo lote
// Si llegan 3 imágenes en 1.5s, se procesan juntas en UNA sola llamada
// ─────────────────────────────────────────────────────────────────────────────
const messageBuffer = new Map(); // phone → { items: [], timer }
const BATCH_WINDOW_MS = 1500;    // ventana de agrupación en milisegundos

function flushBuffer(from) {
  const buffer = messageBuffer.get(from);
  if (!buffer || !buffer.items.length) {
    messageBuffer.delete(from);
    return;
  }

  const items = buffer.items;
  messageBuffer.delete(from);

  // Tomar el último messageId, combinar textos, recolectar todos los mediaIds
  const messageId   = items[items.length - 1].messageId;
  const texts       = items.map(i => i.text).filter(Boolean);
  const mediaIds    = items.map(i => i.mediaId).filter(Boolean);
  const combinedText = texts.join(" ") || null;

  console.log(
    `📦 Lote de +${from}: ${items.length} mensaje(s), ` +
    `${mediaIds.length} foto(s), texto: "${combinedText || "[ninguno]"}"`
  );

  handleMessage("+" + from, combinedText, messageId, mediaIds.length ? mediaIds : null)
    .catch(err => console.error("❌ Error procesando lote de", from, ":", err));
}

function addToBuffer(from, messageId, text, mediaId) {
  if (!messageBuffer.has(from)) {
    messageBuffer.set(from, { items: [], timer: null });
  }

  const buffer = messageBuffer.get(from);

  // Cancelar timer anterior y crear uno nuevo (reset de ventana)
  if (buffer.timer) clearTimeout(buffer.timer);

  buffer.items.push({ messageId, text: text || null, mediaId: mediaId || null });
  buffer.timer = setTimeout(() => flushBuffer(from), BATCH_WINDOW_MS);
}

// ── Webhook verification ──────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook verificado por Meta");
    return res.status(200).send(challenge);
  }
  console.warn("⚠️ Verificación de webhook fallida");
  res.sendStatus(403);
});

// ── Webhook messages ──────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body?.object !== "whatsapp_business_account") return;

    const entry    = body.entry?.[0];
    const changes  = entry?.changes?.[0];
    const value    = changes?.value;
    const messages = value?.messages;
    if (!messages?.length) return;

    for (const msg of messages) {
      const from      = msg.from;
      const messageId = msg.id;

      if (msg.type === "text") {
        // ── Mensaje de texto normal ──────────────────────────────────────
        const text = msg.text?.body;
        if (!text) continue;
        console.log(`📨 Texto de +${from}: "${text.substring(0, 80)}"`);
        addToBuffer(from, messageId, text, null);

      } else if (msg.type === "interactive") {
        // ── Botones o listas ─────────────────────────────────────────────
        const text =
          msg.interactive?.button_reply?.id ||
          msg.interactive?.list_reply?.id ||
          msg.interactive?.button_reply?.title;
        if (!text) continue;
        addToBuffer(from, messageId, text, null);

      } else if (msg.type === "location") {
        // ── Pin de ubicación desde WhatsApp ──────────────────────────────
        const { latitude, longitude, name, address } = msg.location;
        const mapsLink = `https://www.google.com/maps?q=${latitude},${longitude}`;
        const text = name
          ? `Mi ubicación: ${name}${address ? ", " + address : ""} — ${mapsLink}`
          : `Mi ubicación: ${mapsLink}`;
        console.log(`📍 Ubicación de +${from}: ${text}`);
        addToBuffer(from, messageId, text, null);

      } else if (msg.type === "image") {
        // ── Foto — se agrega al buffer y se agrupa con otras fotos ───────
        const mediaId = msg.image?.id;
        const caption = msg.image?.caption || "";
        console.log(`🖼️ Imagen de +${from} (mediaId: ${mediaId})`);
        addToBuffer(from, messageId, caption || null, mediaId);

      } else if (msg.type === "video") {
        // ── Video — Sasha lo maneja con contexto, sin mensaje hardcoded ──
        console.log(`🎥 Video de +${from}`);
        const caption = msg.video?.caption || "";
        // Pasamos contexto textual para que Sasha responda naturalmente
        const videoContext = caption
          ? `[El cliente envió un video con el mensaje: "${caption}"]`
          : "[El cliente envió un video de su proyecto]";
        addToBuffer(from, messageId, videoContext, null);

      } else if (msg.type === "audio") {
        // ── Audio ────────────────────────────────────────────────────────
        console.log(`🎙️ Audio de +${from} — tipo no procesable`);
        const audioContext = "[El cliente envió un mensaje de voz]";
        addToBuffer(from, messageId, audioContext, null);

      } else {
        // ── Sticker, documento, etc. — ignorar silenciosamente ───────────
        console.log(`⚠️ Tipo ignorado: ${msg.type} de +${from}`);
      }
    }
  } catch (err) {
    console.error("❌ Error en POST /webhook:", err);
  }
});

// ── Health & status ───────────────────────────────────────────────────────────
app.get("/", (req, res) =>
  res.json({
    bot: "SS Remodelaciones — Sasha",
    status: "✅ operando",
    api: "Meta WhatsApp Business API",
    features: [
      "visión de fotos (múltiples)",
      "análisis de videos",
      "recordatorios automáticos",
      "detección de idioma",
      "asesoría de diseño e ingeniería",
    ],
    ts: new Date().toISOString(),
  })
);

app.get("/health", (_req, res) =>
  res.json({ ok: true, uptime: process.uptime() })
);

// ── Cotizador Web App ─────────────────────────────────────────────────────────
app.get("/cotizador", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "cotizador.html"));
});

// PWA manifest para instalación en celular
app.get("/cotizador-manifest.json", (_req, res) => {
  res.json({
    name: "Cotizador SSR",
    short_name: "Cotizador",
    description: "SS Remodelaciones — Sistema de cotizaciones",
    start_url: "/cotizador",
    display: "standalone",
    background_color: "#F4F6F9",
    theme_color: "#1B3A6B",
    icons: [{
      src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%231B3A6B'/><text y='68' x='50' font-size='55' text-anchor='middle' fill='%23D4541A' font-family='Arial' font-weight='bold'>SS</text></svg>",
      sizes: "192x192",
      type: "image/svg+xml"
    }]
  });
});

app.get("/test-reminders", async (_req, res) => {
  console.log("🧪 Recordatorios disparados manualmente");
  await sendDailyReminders();
  res.json({ ok: true, message: "Recordatorios ejecutados" });
});

// ── Cotizador SSR ─────────────────────────────────────────────────────────────
app.post("/api/cotizacion", async (req, res) => {
  try {
    const { client, items } = req.body;
    if (!client?.referencia || !client?.nombre || !items?.length) {
      return res.status(400).json({ ok: false, error: "Faltan datos requeridos" });
    }
    console.log(`📋 POST /api/cotizacion — ${client.referencia} (${client.nombre})`);
    const { procesarCotizacion } = require("./bot/cotizacion");
    const result = await procesarCotizacion({ client, items });
    res.json(result);
  } catch (err) {
    console.error("❌ /api/cotizacion error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║  🏗️  SS Remodelaciones — WhatsApp Bot (Sasha)        ║
║  📡  Meta WhatsApp Business API                      ║
║  🤖  IA: Claude Sonnet (visión activada)             ║
║  ⏰  Recordatorios: 8:00 AM CR diario               ║
║  🌐  Idiomas: ES / EN automático                     ║
║  🚀  Puerto: ${PORT}                                    ║
║  📬  Webhook: GET|POST /webhook                      ║
╚══════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
