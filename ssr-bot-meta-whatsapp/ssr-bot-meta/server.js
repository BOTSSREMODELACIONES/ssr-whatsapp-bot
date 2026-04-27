require("dotenv").config();

const express = require("express");
const { handleMessage } = require("./bot/index");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ── Validar variables requeridas ─────────────────────────────────────────────
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

// ── GET /webhook — verificación del webhook con Meta ─────────────────────────
// Meta envía este GET cuando registrás el webhook en el Developer Portal
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

// ── POST /webhook — mensajes entrantes de WhatsApp ───────────────────────────
app.post("/webhook", async (req, res) => {
  // Responder 200 inmediatamente (Meta requiere respuesta rápida)
  res.sendStatus(200);

  try {
    const body = req.body;

    // Verificar que es un evento de WhatsApp Business
    if (body?.object !== "whatsapp_business_account") return;

    const entry    = body.entry?.[0];
    const changes  = entry?.changes?.[0];
    const value    = changes?.value;
    const messages = value?.messages;

    if (!messages?.length) return; // Puede ser status update, no mensaje

    for (const msg of messages) {
      // Solo procesar mensajes de texto e interactivos (botones)
      let text = null;

      if (msg.type === "text") {
        text = msg.text?.body;
      } else if (msg.type === "interactive") {
        // Respuesta a botón o lista
        text =
          msg.interactive?.button_reply?.id ||
          msg.interactive?.list_reply?.id ||
          msg.interactive?.button_reply?.title;
      } else {
        // Audio, imagen, sticker, etc. — respuesta genérica
        const from = msg.from;
        const { sendText } = require("./bot/messenger");
        await sendText(
          from,
          "Por el momento solo puedo procesar mensajes de texto 😊 ¿En qué te puedo ayudar?"
        );
        continue;
      }

      if (!text) continue;

      const from      = msg.from;
      const messageId = msg.id;

      console.log(`📨 De +${from}: "${text.substring(0, 80)}"`);

      // Procesar en background (no bloquear el loop)
      handleMessage("+" + from, text, messageId).catch((err) =>
        console.error("❌ Error procesando mensaje de", from, ":", err)
      );
    }
  } catch (err) {
    console.error("❌ Error en POST /webhook:", err);
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) =>
  res.json({
    bot: "SS Remodelaciones — Sasha",
    status: "✅ operando",
    api: "Meta WhatsApp Business API",
    ts: new Date().toISOString(),
  })
);

app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ── Arrancar ──────────────────────────────────────────────────────────────────
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
