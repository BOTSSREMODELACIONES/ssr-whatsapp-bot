require("dotenv").config();
const express = require("express");
const cron    = require("node-cron");
const path    = require("path");
const https   = require("https");
const fs      = require("fs");
const os      = require("os");
const { handleMessage }       = require("./bot/index");
const { sendDailyReminders }  = require("./bot/reminders");

const app = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const PORT = process.env.PORT || 3000;

const REQUIRED = ["WHATSAPP_TOKEN","WHATSAPP_PHONE_NUMBER_ID","WEBHOOK_VERIFY_TOKEN","ANTHROPIC_API_KEY"];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) { console.error("❌ Variables faltantes:", missing.join(", ")); process.exit(1); }

// ── Administradores (misma lista que en bot/index.js) ─────────────────────────
const SUPERVISOR_NUMS = [
  "+50683091817",  // Darwin
  "+50670068477",  // Darwin (segundo número)
  "+50671981370",  // Melvin
];

// ── Cron: recordatorios 8:00 AM Costa Rica ────────────────────────────────────
cron.schedule("0 8 * * *", async () => {
  console.log("🕐 Cron activado → enviando recordatorios del día...");
  await sendDailyReminders();
}, { timezone: "America/Costa_Rica" });
console.log("✅ Cron de recordatorios registrado (8:00 AM CR diario)");

// ── Buffer de mensajes (agrupa fotos múltiples en un lote) ────────────────────
const messageBuffer   = new Map();
const BATCH_WINDOW_MS = 1500;

function flushBuffer(from) {
  const buffer = messageBuffer.get(from);
  if (!buffer || !buffer.items.length) { messageBuffer.delete(from); return; }
  const items        = buffer.items;
  messageBuffer.delete(from);
  const messageId    = items[items.length - 1].messageId;
  const texts        = items.map(i => i.text).filter(Boolean);
  const mediaIds     = items.map(i => i.mediaId).filter(Boolean);
  const combinedText = texts.join(" ") || null;
  console.log(`📦 Lote de +${from}: ${items.length} msg, ${mediaIds.length} foto(s), texto: "${combinedText || "[ninguno]"}"`);
  handleMessage("+" + from, combinedText, messageId, mediaIds.length ? mediaIds : null)
    .catch(err => console.error("❌ Error procesando lote de", from, ":", err));
}

function addToBuffer(from, messageId, text, mediaId) {
  if (!messageBuffer.has(from)) messageBuffer.set(from, { items: [], timer: null });
  const buffer = messageBuffer.get(from);
  if (buffer.timer) clearTimeout(buffer.timer);
  buffer.items.push({ messageId, text: text || null, mediaId: mediaId || null });
  buffer.timer = setTimeout(() => flushBuffer(from), BATCH_WINDOW_MS);
}

// ── Transcribir audio con Whisper (OpenAI) ────────────────────────────────────
/**
 * Descarga el audio de WhatsApp y lo transcribe con Whisper.
 * Whisper es la única API que realmente entiende audio — Claude no procesa audio nativo.
 *
 * @param {string} audioId   - Media ID del audio en WhatsApp
 * @param {string} mimeType  - MIME type del audio (ej: audio/ogg, audio/mpeg)
 * @returns {Promise<string>} texto transcrito
 */
async function transcribirConWhisper(audioId, mimeType = "audio/ogg") {
  const { downloadMedia } = require("./bot/messenger");

  // 1. Descargar audio desde Meta en base64
  const { base64, mimeType: detectedMime } = await downloadMedia(audioId);
  const finalMime = detectedMime || mimeType;

  // 2. Convertir base64 a buffer y guardar en archivo temporal
  const buffer  = Buffer.from(base64, "base64");
  const ext     = finalMime.includes("ogg") ? "ogg"
                : finalMime.includes("mpeg") || finalMime.includes("mp3") ? "mp3"
                : finalMime.includes("mp4") || finalMime.includes("m4a") ? "m4a"
                : finalMime.includes("webm") ? "webm"
                : "ogg";
  const tmpFile = path.join(os.tmpdir(), `sasha_audio_${audioId}.${ext}`);
  fs.writeFileSync(tmpFile, buffer);

  console.log(`🎙️ Audio descargado: ${Math.round(buffer.length / 1024)}KB (${finalMime}) → ${tmpFile}`);

  try {
    // 3. Enviar a Whisper via multipart/form-data
    const apiKey   = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY no configurada — no se puede transcribir audio");

    const boundary = `----WhisperBoundary${Date.now()}`;
    const fileData = fs.readFileSync(tmpFile);
    const filename = `audio.${ext}`;

    // Construir body multipart manualmente (sin deps extra)
    const parts = [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nes\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${finalMime}\r\n\r\n`),
      fileData,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ];
    const body = Buffer.concat(parts);

    const resultado = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "api.openai.com",
        path:     "/v1/audio/transcriptions",
        method:   "POST",
        headers:  {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type":  `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      }, (res) => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => resolve(data));
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });

    const json = JSON.parse(resultado);
    if (!json.text) throw new Error(`Whisper no retornó texto: ${resultado.slice(0, 200)}`);

    console.log(`🎙️ Whisper transcribió: "${json.text.slice(0, 100)}"`);
    return json.text.trim();

  } finally {
    // Limpiar archivo temporal siempre
    try { fs.unlinkSync(tmpFile); } catch { /* ignorar */ }
  }
}

// ── Procesar nota de voz de supervisor ───────────────────────────────────────
/**
 * Cuando un admin manda una nota de voz:
 * 1. Transcribe con Whisper
 * 2. Confirma al admin lo que escuchó
 * 3. Procesa el texto como comando admin (finanzas, outbound, CRM, etc.)
 */
async function transcribirYEjecutarComando(from, audioId, messageId) {
  const { sendText } = require("./bot/messenger");
  const fromE164 = "+" + from;

  try {
    await sendText(fromE164, "🎙️ _Procesando tu nota de voz..._");

    const texto = await transcribirConWhisper(audioId);

    if (!texto || texto.length < 2) {
      await sendText(fromE164,
        "❌ No pude entender el audio.\n\nEscribí el comando directamente, por ejemplo:\n" +
        "_pagué 50 mil de gasolina_\n_envíale a María que mañana es la visita_\n_listar clientes_"
      );
      return;
    }

    // Confirmar al admin lo que escuchó antes de ejecutar
    await sendText(fromE164, `🎙️ _Escuché: "${texto}"_\n\nProcesando...`);

    // Procesar como comando admin normal
    await handleMessage(fromE164, texto, messageId, null);

  } catch (err) {
    console.error("❌ Error transcribiendo voz de supervisor:", err.message);
    await sendText(fromE164,
      "❌ Error al procesar el audio. Asegurate que la variable OPENAI_API_KEY esté configurada.\n\n" +
      "Mientras tanto podés escribir el comando directamente."
    ).catch(() => {});
  }
}

// ── Webhook verification ───────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook verificado por Meta");
    return res.status(200).send(challenge);
  }
  console.warn("⚠️  Verificación de webhook fallida");
  res.sendStatus(403);
});

// ── Webhook messages (WhatsApp + Facebook + Instagram) ───────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;

    // ── Facebook Messenger DMs y comentarios ─────────────────────────────────
    if (body?.object === "page") {
      const { handleFBDM, handleFBComment } = require("./bot/social");
      for (const entry of (body.entry || [])) {
        for (const event of (entry.messaging || [])) {
          const senderId = event.sender?.id;
          const pageId   = event.recipient?.id;
          const fbPageId = process.env.FB_PAGE_ID;
          if (!senderId || senderId === pageId || senderId === fbPageId) continue;
          const text = event.message?.text;
          if (!text) continue;
          console.log(`💙 FB Messenger de ${senderId}: "${text.substring(0, 60)}"`);
          handleFBDM(senderId, text, null).catch(e => console.error("❌ handleFBDM:", e.message));
        }
        for (const change of (entry.changes || [])) {
          if (change.field !== "feed") continue;
          const val = change.value;
          if (val?.item !== "comment" || val?.verb !== "add") continue;
          const commentId = val.comment_id;
          const texto     = val.message;
          const userName  = val.from?.name || "Usuario";
          const postId    = val.post_id;
          if (!commentId || !texto) continue;
          if (val.from?.id === process.env.FB_PAGE_ID) continue;
          console.log(`💙 FB Comentario de ${userName}: "${texto.substring(0, 60)}"`);
          handleFBComment(commentId, texto, userName, postId).catch(e => console.error("❌ handleFBComment:", e.message));
        }
      }
      return;
    }

    // ── Instagram DMs y comentarios ───────────────────────────────────────────
    if (body?.object === "instagram") {
      const { handleIGDM, handleIGComment } = require("./bot/social");
      const igAccountId = process.env.INSTAGRAM_ACCOUNT_ID;
      for (const entry of (body.entry || [])) {
        for (const event of (entry.messaging || [])) {
          const senderId = event.sender?.id;
          if (!senderId || senderId === igAccountId) continue;
          const text = event.message?.text;
          if (!text) continue;
          console.log(`🟣 IG DM de ${senderId}: "${text.substring(0, 60)}"`);
          handleIGDM(senderId, text, null).catch(e => console.error("❌ handleIGDM:", e.message));
        }
        for (const change of (entry.changes || [])) {
          if (change.field !== "comments") continue;
          const val       = change.value;
          const commentId = val?.id;
          const texto     = val?.text;
          const userId    = val?.from?.id;
          const mediaId   = val?.media?.id || "unknown";
          if (!commentId || !texto || !userId) continue;
          if (userId === igAccountId) continue;
          console.log(`🟣 IG Comentario de ${userId}: "${texto.substring(0, 60)}"`);
          handleIGComment(commentId, texto, userId, mediaId).catch(e => console.error("❌ handleIGComment:", e.message));
        }
      }
      return;
    }

    // ── WhatsApp ──────────────────────────────────────────────────────────────
    if (body?.object !== "whatsapp_business_account") return;
    const messages = body.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return;

    for (const msg of messages) {
      const from      = msg.from;
      const messageId = msg.id;
      const fromE164  = "+" + from;

      if (msg.type === "text") {
        const text = msg.text?.body;
        if (!text) continue;
        console.log(`📨 Texto de +${from}: "${text.substring(0, 80)}"`);
        addToBuffer(from, messageId, text, null);

      } else if (msg.type === "interactive") {
        const text = msg.interactive?.button_reply?.id
          || msg.interactive?.list_reply?.id
          || msg.interactive?.button_reply?.title;
        if (!text) continue;
        addToBuffer(from, messageId, text, null);

      } else if (msg.type === "location") {
        const { latitude, longitude, name, address } = msg.location;
        const mapsLink = `https://www.google.com/maps?q=${latitude},${longitude}`;
        const text = name
          ? `Mi ubicación: ${name}${address ? ", " + address : ""} ⇒ ${mapsLink}`
          : `Mi ubicación: ${mapsLink}`;
        console.log(`📍 Ubicación de +${from}: ${text}`);
        addToBuffer(from, messageId, text, null);

      } else if (msg.type === "image") {
        const mediaId = msg.image?.id;
        const caption = msg.image?.caption || "";
        console.log(`🖼️  Imagen de +${from} (mediaId: ${mediaId})`);
        addToBuffer(from, messageId, caption || null, mediaId);

      } else if (msg.type === "video") {
        const caption      = msg.video?.caption || "";
        const videoContext = caption
          ? `[El cliente envió un video con el mensaje: "${caption}"]`
          : "[El cliente envió un video de su proyecto]";
        addToBuffer(from, messageId, videoContext, null);

      } else if (msg.type === "audio") {
        const audioId    = msg.audio?.id;
        const audioMime  = msg.audio?.mime_type || "audio/ogg";

        if (SUPERVISOR_NUMS.includes(fromE164)) {
          // ── Admin mandó nota de voz → transcribir con Whisper y ejecutar ──
          console.log(`🎙️ Nota de voz de ADMIN ${from} (${audioMime}) → transcribiendo con Whisper...`);
          if (audioId) {
            transcribirYEjecutarComando(from, audioId, messageId)
              .catch(err => console.error("❌ transcribirYEjecutarComando:", err.message));
          } else {
            const { sendText } = require("./bot/messenger");
            sendText(fromE164, "❌ No pude acceder al audio. Intentá escribir el comando.").catch(() => {});
          }
        } else {
          // ── Cliente mandó nota de voz → texto genérico + reenviar a admins ─
          addToBuffer(from, messageId, "[El cliente envió un mensaje de voz]", null);
          if (audioId) {
            const { sendMediaById, sendText: st } = require("./bot/messenger");
            const clientLabel = from;
            for (const sup of SUPERVISOR_NUMS) {
              sendMediaById(sup, audioId, "audio")
                .catch(e => console.warn(`⚠️ No se pudo reenviar audio a ${sup}:`, e.message));
              st(sup, `🎙️ *Audio de cliente +${clientLabel}*`).catch(() => {});
            }
          }
        }

      } else {
        console.log(`⚠️  Tipo ignorado: ${msg.type} de +${from}`);
      }
    }
  } catch (err) {
    console.error("❌ Error en POST /webhook:", err);
  }
});

// ── Meta Lead Ads Webhook ─────────────────────────────────────────────────────
app.get("/meta-lead", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook Meta Lead verificado");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post("/meta-lead", async (req, res) => {
  try {
    console.log("🔥 Nuevo lead Meta recibido:", JSON.stringify(req.body, null, 2));

    let nombre, telefono, interes, zona;
    const body = req.body;

    if (body?.entry?.[0]?.changes?.[0]?.value?.leads) {
      const lead   = body.entry[0].changes[0].value.leads[0];
      const campos = lead.field_data || [];
      nombre   = campos.find(c => c.name === "full_name")?.values?.[0] || "Cliente";
      telefono = campos.find(c => c.name === "phone_number")?.values?.[0] || "";
      interes  = campos.find(c => c.name === "what_service_are_you_interested_in" || c.name === "interes")?.values?.[0] || "remodelación";
      zona     = campos.find(c => c.name === "zone" || c.name === "zona")?.values?.[0] || "Costa Rica";
    } else {
      nombre   = body.nombre   || body.full_name    || "Cliente";
      telefono = body.telefono || body.phone_number || "";
      interes  = body.interes  || body.servicio     || "remodelación";
      zona     = body.zona     || body.zone         || "Costa Rica";
    }

    if (!telefono) {
      console.warn("⚠️ Lead recibido sin teléfono");
      return res.status(400).json({ ok: false, error: "Sin teléfono" });
    }

    let telefonoNorm = telefono.replace(/\D/g, "");
    if (!telefonoNorm.startsWith("506") && telefonoNorm.length === 8) {
      telefonoNorm = "506" + telefonoNorm;
    }

    console.log(`📲 Procesando lead: ${nombre} | +${telefonoNorm} | ${interes} | ${zona}`);

    const { sendText } = require("./bot/messenger");

    const mensaje =
      `Hola ${nombre} 👋\n\n` +
      `Soy *Sasha*, asistente de *SS Remodelaciones*.\n\n` +
      `Recibimos su solicitud sobre *${interes}* y será un gusto ayudarle 😊\n\n` +
      `¿Podría contarme un poco más sobre el proyecto que tiene en mente?`;

    await sendText("+" + telefonoNorm, mensaje);
    console.log(`✅ WhatsApp enviado a +${telefonoNorm}`);

    const notifSup =
      `🔥 *Nuevo lead Meta Ads*\n\n` +
      `👤 Nombre: ${nombre}\n` +
      `📱 Teléfono: +${telefonoNorm}\n` +
      `🔨 Interés: ${interes}\n` +
      `📍 Zona: ${zona}\n\n` +
      `✅ Sasha ya le escribió automáticamente.`;

    for (const sup of SUPERVISOR_NUMS) {
      sendText(sup, notifSup).catch(e => console.warn(`⚠️ No se pudo notificar a ${sup}:`, e.message));
    }

    if (process.env.MAKE_WEBHOOK_META_LEADS) {
      try {
        await fetch(process.env.MAKE_WEBHOOK_META_LEADS, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            nombre, telefono: "+" + telefonoNorm, interes, zona,
            fuente: "Meta Ads",
            fecha:  new Date().toLocaleString("es-CR", { timeZone: "America/Costa_Rica" }),
            estado: "Nuevo lead",
          }),
        });
        console.log("✅ Lead registrado en CRM via Make");
      } catch (errMake) {
        console.warn("⚠️ No se pudo registrar en CRM:", errMake.message);
      }
    } else {
      console.warn("⚠️ MAKE_WEBHOOK_META_LEADS no configurado — lead no registrado en CRM");
    }

    res.json({ ok: true, mensaje: "Lead procesado correctamente" });

  } catch (err) {
    console.error("❌ Error META LEAD:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Outbound API (para Make / n8n) ────────────────────────────────────────────
app.post("/api/outbound", async (req, res) => {
  try {
    const token = req.headers["x-outbound-token"] || req.body.token;
    if (!process.env.OUTBOUND_SECRET || token !== process.env.OUTBOUND_SECRET) {
      console.warn("⚠️  /api/outbound — token inválido");
      return res.status(401).json({ ok: false, error: "No autorizado" });
    }

    const { to, message, nombre } = req.body;
    if (!to && !nombre) return res.status(400).json({ ok: false, error: "Se requiere 'to' o 'nombre'" });
    if (!message)       return res.status(400).json({ ok: false, error: "Se requiere 'message'" });

    const { enviarProactivo, resolverTelefono } = require("./bot/outbound");

    let telefono = to;
    if (!telefono && nombre) {
      telefono = await resolverTelefono(nombre);
      if (!telefono) return res.status(404).json({ ok: false, error: `No encontré cliente: "${nombre}"` });
    }

    const resultado = await enviarProactivo(telefono, message.trim());

    if (resultado.ok) {
      console.log(`✅ /api/outbound → +${telefono} [${resultado.method}]`);
      res.json({ ok: true, to: "+" + telefono.replace(/\D/g, ""), method: resultado.method, message: message.trim() });
    } else {
      res.status(500).json({ ok: false, error: resultado.error });
    }
  } catch (err) {
    console.error("❌ /api/outbound:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Health & status ────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({
  bot:      "SS Remodelaciones ∙ Sasha",
  status:   "✅ operando",
  api:      "Meta WhatsApp Business API",
  features: ["visión de fotos", "notas de voz admin (Whisper)", "outbound proactivo", "memoria CRM", "recordatorios", "Meta Lead Ads"],
  ts:       new Date().toISOString(),
}));

app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ── Cotizador Web App ──────────────────────────────────────────────────────────
app.get("/cotizador", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.sendFile(path.join(__dirname, "public", "cotizador.html"));
});

app.get("/cotizador-manifest.json", (_req, res) => {
  res.json({
    name: "Cotizador SSR", short_name: "Cotizador",
    description: "SS Remodelaciones ∙ Sistema de cotizaciones",
    start_url: "/cotizador", display: "standalone",
    background_color: "#F4F6F9", theme_color: "#1B3A6B",
    icons: [{ src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%231B3A6B'/><text y='68' x='50' font-size='55' text-anchor='middle' fill='%23D4541A' font-family='Arial' font-weight='bold'>SS</text></svg>", sizes: "192x192", type: "image/svg+xml" }],
  });
});

// ── Test helpers ───────────────────────────────────────────────────────────────
app.get("/test-reminders", async (_req, res) => {
  await sendDailyReminders();
  res.json({ ok: true, message: "Recordatorios ejecutados" });
});

app.get("/test-meta-lead", async (req, res) => {
  try {
    const payload = {
      nombre:   req.query.nombre   || "Cliente Prueba",
      telefono: req.query.telefono || "50671951695",
      interes:  req.query.interes  || "Remodelación de cocina",
      zona:     req.query.zona     || "Heredia",
    };
    console.log("🧪 Test Meta Lead:", payload);
    const r    = await fetch(`http://localhost:${PORT}/meta-lead`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });
    const data = await r.json();
    res.json({ ok: true, test: payload, resultado: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Cotizador: procesar notas con IA ──────────────────────────────────────────
app.post("/api/procesar-notas", async (req, res) => {
  try {
    const { notas, fotos, pdfs } = req.body;
    const Anthropic  = require("@anthropic-ai/sdk");
    const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const pdfCtx = (pdfs||[]).length > 0
      ? "\n\nDOCUMENTOS/PLANOS:\n" + pdfs.map(p => "--- " + p.name + " ---\n" + p.text).join("\n\n")
      : "";

    const systemPrompt = `Sos experto en presupuestos de construccion y remodelacion en Costa Rica. Responde SOLO JSON puro valido sin markdown ni backticks ni simbolos especiales fuera del JSON.

REGLAS:
1. Corrige ortografia y acentos en todas las descripciones.
2. Precios de referencia en Costa Rica: Construplaza, EPA, El Lagar, Mundo Iluminacion, Ferreteria El Colono, Maderas MM, PriceSmart.
3. Si el material es especializado, buscalo en internet y pon en fuente el sitio donde lo encontraste.
4. Si no encontras precio confiable, pon fuente: "Cotizar".

REGLA CRITICA — MATERIALES EXHAUSTIVOS:
Para CADA actividad incluye ABSOLUTAMENTE TODOS los materiales, herramientas y consumibles necesarios para ejecutarla de principio a fin.

Formato de respuesta:
{
  "items": [
    {
      "id": "string unico",
      "descripcion": "descripcion clara del trabajo",
      "dias": numero,
      "operarios": numero,
      "ayudantes": numero,
      "materiales": [
        {
          "detalle": "nombre del material",
          "cantidad": numero,
          "unidad": "unidad de medida",
          "precio_unitario": numero en colones,
          "fuente": "tienda o Cotizar"
        }
      ]
    }
  ]
}`;

    const content = [];

    if (fotos && fotos.length > 0) {
      fotos.slice(0, 5).forEach(f => {
        if (f.base64) {
          content.push({ type: "image", source: { type: "base64", media_type: f.mimeType || "image/jpeg", data: f.base64 } });
        }
      });
    }

    content.push({ type: "text", text: `Notas del proyecto:\n${notas || ""}${pdfCtx}\n\nGenerá el presupuesto completo en JSON.` });

    function escaparComillasInternas(s) {
      let inStr = false, result = "";
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '"') {
          const prev = s[i-1] || "", next = s[i+1] || "";
          if (!inStr) { inStr = true; result += c; continue; }
          if ([",", ":", "}", "]", "\n", " ", ""].includes(next) || ["}", "]", ","].includes(prev.trim().slice(-1))) {
            inStr = false; result += c;
          } else { result += '\\"'; }
        } else { result += c; }
      }
      return result;
    }

    function parsearJSON(raw) {
      let s = raw.replace(/```json/gi, "").replace(/```/g, "").trim()
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"').replace(/[\u2018\u2019\u201A\u201B]/g, "'");
      const a = s.indexOf("{");
      if (a < 0) throw new Error("No JSON en respuesta");
      let depth = 0, b = -1, inStr = false, esc = false;
      for (let i = a; i < s.length; i++) {
        const c = s[i];
        if (esc)           { esc = false; continue; }
        if (c === "\\" && inStr) { esc = true; continue; }
        if (c === '"')     { inStr = !inStr; continue; }
        if (inStr)         continue;
        if (c === "{")     depth++;
        else if (c === "}") { depth--; if (depth === 0) { b = i; break; } }
      }
      if (b < 0) b = s.lastIndexOf("}");
      if (b < 0) throw new Error("No JSON");
      s = s.slice(a, b + 1)
        .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, "").replace(/\r?\n/g, " ").replace(/\t/g, " ")
        .replace(/"precio_unitario"\s*:\s*(\d+),(\d{3})\b/g, '"precio_unitario": $1$2')
        .replace(/"cantidad"\s*:\s*(\d+),(\d{3})\b/g, '"cantidad": $1$2')
        .replace(/,(\s*[}\]])/g, "$1");
      try { return JSON.parse(s); }
      catch (e1) {
        try { return JSON.parse(escaparComillasInternas(s)); }
        catch (e2) {
          const sAscii = s.replace(/[^\x20-\x7E\u00C0-\u024F\u20A1]/g, " ");
          return JSON.parse(escaparComillasInternas(sAscii));
        }
      }
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    async function callClaudeWithRetry(opts, label) {
      for (let intento = 1; intento <= 3; intento++) {
        try {
          const r   = await anthropic.messages.create(opts);
          const txt = (r.content || []).filter(b => b.type === "text").map(b => b.text).join("") || r.content?.[0]?.text || "";
          if (!txt) throw new Error("Sin texto en respuesta");
          return parsearJSON(txt);
        } catch (err) {
          const is429 = err.status === 429 || String(err.message).includes("rate_limit");
          if (is429 && intento < 3) {
            const wait = intento === 1 ? 65000 : 35000;
            console.warn(`⚠️ Rate limit 429 en ${label} — reintentando en ${wait/1000}s...`);
            await sleep(wait);
          } else { throw err; }
        }
      }
    }

    const maxTok = 8192;
    let data;
    try {
      data = await callClaudeWithRetry({
        model: "claude-sonnet-4-6", max_tokens: maxTok,
        system: systemPrompt, messages: [{ role: "user", content }],
      }, "/api/procesar-notas sin web_search");
    } catch (e1) {
      console.warn("⚠️ Sin web_search falló, reintentando con web_search...");
      data = await callClaudeWithRetry({
        model: "claude-sonnet-4-6", max_tokens: maxTok,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        system: systemPrompt, messages: [{ role: "user", content }],
      }, "/api/procesar-notas con web_search");
    }

    res.json({ ok: true, data });
  } catch (err) {
    console.error("❌ /api/procesar-notas:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Cotizacion → Drive ────────────────────────────────────────────────────────
app.post("/api/cotizacion", async (req, res) => {
  try {
    const { client, items } = req.body;
    if (!client?.referencia || !client?.nombre || !items?.length)
      return res.status(400).json({ ok: false, error: "Faltan datos requeridos" });
    console.log(`📋 POST /api/cotizacion → ${client.referencia} (${client.nombre})`);
    const { procesarCotizacion } = require("./bot/cotizacion");
    const result = await procesarCotizacion({ client, items });
    res.json(result);
  } catch (err) {
    console.error("❌ /api/cotizacion error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Transcripción de voz (endpoint para cotizador web) ───────────────────────
app.post("/api/transcribir-voz", async (req, res) => {
  try {
    const { audio, mimeType } = req.body;
    if (!audio) return res.status(400).json({ ok: false, error: "Sin audio" });

    const Anthropic = require("@anthropic-ai/sdk");
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    try {
      const r = await anthropic.messages.create({
        model:   "claude-sonnet-4-6",
        max_tokens: 1000,
        system:  "Sos un asistente que transcribe notas de obras de construccion en Costa Rica. Transcribí el audio exactamente como fue dicho, en español. Solo devolvé el texto transcrito, sin explicaciones ni formato extra.",
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: mimeType || "audio/webm", data: audio } },
            { type: "text", text: "Transcribí este audio de notas de obra de construccion en Costa Rica." },
          ],
        }],
      });
      const texto = (r.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
      if (texto) {
        console.log("✅ /api/transcribir-voz OK:", texto.slice(0, 60));
        return res.json({ ok: true, texto });
      }
    } catch (e) {
      console.warn("⚠️ Claude no pudo procesar el audio:", e.message);
    }

    res.json({ ok: false, error: "Transcripción no disponible" });
  } catch (err) {
    console.error("🔥 /api/transcribir-voz:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── SETUP TEMPORAL — Crear campaña Meta Ads ───────────────────────────────────
app.get("/api/crear-campana", async (req, res) => {
  if (req.query.token !== process.env.WEBHOOK_VERIFY_TOKEN) {
    return res.status(401).json({ error: "No autorizado" });
  }
  try {
    const { execFile } = require("child_process");
    execFile(
      "node",
      ["crear_campana_cocinas.js"],
      { env: process.env, cwd: "/app" },
      (error, stdout, stderr) => {
        if (error) {
          console.error("❌ crear-campana error:", error.message);
          return res.json({ ok: false, error: error.message, detalle: stderr });
        }
        console.log("✅ crear-campana finalizado");
        res.json({ ok: true, resultado: stdout });
      }
    );
  } catch (err) {
    console.error("❌ /api/crear-campana:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── CONTROL DE ASISTENCIA SSR REMODELACIONES (GLIDE + GOOGLE SHEETS) ──────────
app.post("/webhook-asistencia", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ ok: false, error: "Mensaje vacío" });

    console.log(`⏰ Alerta recibida de Sheets: "${message}"`);

    const { sendText } = require("./bot/messenger");

    for (const sup of SUPERVISOR_NUMS) {
      await sendText(sup, message).catch(e =>
        console.warn(`⚠️ No se pudo enviar reporte de asistencia a ${sup}:`, e.message)
      );
    }

    return res.status(200).json({ ok: true, status: "Notificaciones enviadas" });
  } catch (error) {
    console.error("❌ Error en Webhook de Asistencia:", error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ── Servidor ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
┌────────────────────────────────────────────────────────────┐
│  🏗️  SS Remodelaciones ∙ WhatsApp Bot (Sasha)              │
│  🤖  IA: Claude Sonnet                                     │
│  🎙️  Notas de voz: Whisper (OpenAI) para admins           │
│  ⏰  Recordatorios: 8:00 AM CR diario                      │
│  🚀  Puerto: ${PORT}                                       │
│  📌  Webhook WhatsApp: GET|POST /webhook                   │
│  🔥  Webhook Meta Leads: GET|POST /meta-lead               │
│  📊  Webhook Asistencia Sheets: POST /webhook-asistencia   │
└────────────────────────────────────────────────────────────┘
  `);
});

module.exports = app;
