require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const { handleMessage } = require("./bot/index");
const { sendDailyReminders } = require("./bot/reminders");

const app = express();
app.use(express.json());

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

    const { sendText } = require("./bot/messenger");

    for (const msg of messages) {
      const from      = msg.from;
      const messageId = msg.id;
      let text    = null;
      let mediaId = null;

      if (msg.type === "text") {
        // ── Mensaje de texto normal ──────────────────────────────────────
        text = msg.text?.body;

      } else if (msg.type === "interactive") {
        // ── Botones o listas ─────────────────────────────────────────────
        text =
          msg.interactive?.button_reply?.id ||
          msg.interactive?.list_reply?.id ||
          msg.interactive?.button_reply?.title;

      } else if (msg.type === "location") {
        // ── Pin de ubicación desde WhatsApp ──────────────────────────────
        const { latitude, longitude, name, address } = msg.location;
        const mapsLink = `https://www.google.com/maps?q=${latitude},${longitude}`;
        text = name
          ? `Mi ubicación: ${name}${address ? ", " + address : ""} — ${mapsLink}`
          : `Mi ubicación: ${mapsLink}`;
        console.log(`📍 Ubicación recibida de +${from}: ${text}`);

      } else if (msg.type === "image") {
        // ── Foto del cliente ─────────────────────────────────────────────
        mediaId = msg.image?.id;
        text    = msg.image?.caption || "";
        console.log(`🖼️ Imagen recibida de +${from} (mediaId: ${mediaId})`);

      } else if (msg.type === "video") {
        // ── Video: pedimos foto ──────────────────────────────────────────
        console.log(`🎥 Video recibido de +${from} — solicitando foto`);
        await sendText(
          from,
          "Recibí su video 📹 Por el momento solo puedo analizar fotos. ¿Podría enviarme una imagen del área? Así le asesoro mejor 😊"
        );
        continue;

      } else {
        // ── Audio, sticker, documento, etc. ─────────────────────────────
        console.log(`⚠️ Tipo no soportado: ${msg.type} de +${from}`);
        await sendText(
          from,
          "Por el momento solo proceso mensajes de texto, fotos y ubicaciones 😊 ¿En qué le puedo ayudar?"
        );
        continue;
      }

      if (!text && !mediaId) continue;

      console.log(`📨 De +${from}: "${(text || "[foto]").substring(0, 80)}"`);
      handleMessage("+" + from, text, messageId, mediaId).catch((err) =>
        console.error("❌ Error procesando mensaje de", from, ":", err)
      );
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
    features: ["visión de fotos", "recordatorios automáticos", "detección de idioma"],
    ts: new Date().toISOString(),
  })
);

app.get("/health", (_req, res) =>
  res.json({ ok: true, uptime: process.uptime() })
);

// ── Endpoint manual para probar recordatorios sin esperar el cron ─────────────
app.get("/test-reminders", async (_req, res) => {
  console.log("🧪 Recordatorios disparados manualmente");
  await sendDailyReminders();
  res.json({ ok: true, message: "Recordatorios ejecutados" });
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
