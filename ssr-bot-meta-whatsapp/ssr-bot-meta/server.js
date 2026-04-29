require("dotenv").config();

const express = require("express");
const { handleMessage } = require("./bot/index");

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
      let text = null;
      const from = msg.from;
      const messageId = msg.id;
      const { sendText } = require("./bot/messenger");

      if (msg.type === "text") {
        text = msg.text?.body;

      } else if (msg.type === "interactive") {
        text =
          msg.interactive?.button_reply?.id ||
          msg.interactive?.list_reply?.id ||
          msg.interactive?.button_reply?.title;

      } else if (msg.type === "location") {
        // Pin de ubicación desde WhatsApp
        const { latitude, longitude, name, address } = msg.location;
        const mapsLink = `https://www.google.com/maps?q=${latitude},${longitude}`;
        text = name
          ? `Mi ubicación: ${name}${address ? ", " + address : ""} — ${mapsLink}`
          : `Mi ubicación: ${mapsLink}`;
        console.log(`📍 Ubicación recibida de +${from}: ${text}`);

      } else {
        // Audio, imagen, sticker, etc.
        await sendText(
          from,
          "Por el momento solo puedo procesar mensajes de texto o ubicaciones 😊 ¿En qué te puedo ayudar?"
        );
        continue;
      }

      if (!text) continue;

      console.log(`📨 De +${from}: "${text.substring(0, 80)}"`);

      handleMessage("+" + from, text, messageId).catch((err) =>
        console.error("❌ Error procesando mensaje de", from, ":", err)
      );
    }
  } catch (err) {
    console.error("❌ Error en POST /webhook:", err);
  }
});

app.get("/", (req, res) =>
  res.json({
    bot: "SS Remodelaciones — Sasha",
    status: "✅ operando",
    api: "Meta WhatsApp Business API",
    ts: new Date().toISOString(),
  })
);

app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║  🏗️  SS Remodelaciones — WhatsApp Bot (Sasha)        ║
║  📡  Meta WhatsApp Business API                      ║
║  🤖  IA: Claude Sonnet                               ║
║  🚀  Puerto: ${PORT}                                    ║
║  📬  Webhook: GET|POST /webhook                      ║
╚══════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
