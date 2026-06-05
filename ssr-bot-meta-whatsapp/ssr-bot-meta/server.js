require("dotenv").config();
const express = require("express");
const cron    = require("node-cron");
const path    = require("path");
const { handleMessage }       = require("./bot/index");
const { sendDailyReminders }  = require("./bot/reminders");
const memoria                 = require("./bot/memoria");

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

// ── Cron: recordatorios 8:00 AM Costa Rica ────────────────────────────────────
cron.schedule("0 8 * * *", async () => {
  console.log("🕐 Cron activado → enviando recordatorios del día...");
  await sendDailyReminders();
}, { timezone: "America/Costa_Rica" });
console.log("✅ Cron de recordatorios registrado (8:00 AM CR diario)");

// ── Números internos (supervisores / Melvin) ──────────────────────────────────
const NUMEROS_INTERNOS = new Set([
  "50683091817",  // Darwin
  "50671981370",  // Melvin
  "50670068477",  // Mauricio
]);

// ── Transcripción de audio vía Claude ────────────────────────────────────────
async function transcribirAudio(audioId, esInterno) {
  try {
    const { downloadMedia } = require("./bot/messenger");
    const Anthropic = require("@anthropic-ai/sdk");
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const { base64, mimeType } = await downloadMedia(audioId);

    const systemPrompt = esInterno
      ? "Sos un asistente que transcribe instrucciones internas de SS Remodelaciones. " +
        "El mensaje viene de un supervisor o de Melvin. " +
        "Transcribí el audio exactamente como fue dicho, en español costarricense. " +
        "Solo devolvé el texto transcrito, sin explicaciones ni formato extra."
      : "Sos un asistente que transcribe mensajes de clientes de SS Remodelaciones en Costa Rica. " +
        "Transcribí el audio exactamente como fue dicho, en español. " +
        "Solo devolvé el texto transcrito, sin explicaciones ni formato extra.";

    const r = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      system: systemPrompt,
      messages: [{
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: mimeType || "audio/ogg", data: base64 }
          },
          { type: "text", text: "Transcribí este audio." }
        ]
      }]
    });

    const texto = (r.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("")
      .trim();

    return texto || null;

  } catch (err) {
    console.error("❌ Error en transcribirAudio:", err.message);
    return null;
  }
}

// ── Buffer de mensajes (agrupa fotos múltiples en un lote) ────────────────────
const messageBuffer  = new Map();
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

// ── Webhook messages ───────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body?.object !== "whatsapp_business_account") return;
    const messages = body.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return;

    for (const msg of messages) {
      const from      = msg.from;
      const messageId = msg.id;

      if (msg.type === "text") {
        const text = msg.text?.body;
        if (!text) continue;
        console.log(`📨 Texto de +${from}: "${text.substring(0, 80)}"`);
        addToBuffer(from, messageId, text, null);

      } else if (msg.type === "interactive") {
        const text =
          msg.interactive?.button_reply?.id   ||
          msg.interactive?.list_reply?.id     ||
          msg.interactive?.button_reply?.title;
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
        const caption = msg.video?.caption || "";
        const videoContext = caption
          ? `[El cliente envió un video con el mensaje: "${caption}"]`
          : "[El cliente envió un video de su proyecto]";
        addToBuffer(from, messageId, videoContext, null);

      } else if (msg.type === "audio") {
        const audioId   = msg.audio?.id;
        const esInterno = NUMEROS_INTERNOS.has(from);

        if (audioId) {
          console.log(`🎙️  Audio de +${from} (interno: ${esInterno}) — transcribiendo...`);
          (async () => {
            const transcripcion = await transcribirAudio(audioId, esInterno);
            if (transcripcion) {
              console.log(`✅ Transcripción +${from}: "${transcripcion.slice(0, 100)}"`);
              const textoFinal = esInterno
                ? `[Instrucción de voz de supervisor (${from}): "${transcripcion}"]`
                : transcripcion;
              addToBuffer(from, messageId, textoFinal, null);
              if (esInterno) {
                const { sendText } = require("./bot/messenger");
                sendText("+" + from, `🎙️ Entendido. Procesando: _"${transcripcion.slice(0, 120)}"_`)
                  .catch(e => console.warn("⚠️ No se pudo confirmar transcripción a interno:", e.message));
              }
            } else {
              console.warn(`⚠️ Transcripción falló para +${from}, usando fallback`);
              const fallback = esInterno
                ? `[Audio de supervisor ${from} — no se pudo transcribir. Por favor enviá el mensaje como texto.]`
                : "[El cliente envió un mensaje de voz]";
              addToBuffer(from, messageId, fallback, null);
              if (esInterno) {
                const { sendText } = require("./bot/messenger");
                sendText("+" + from, "⚠️ No pude transcribir ese audio. ¿Podés enviar la instrucción como texto?")
                  .catch(() => {});
              }
            }
          })();
        } else {
          addToBuffer(from, messageId, "[El cliente envió un mensaje de voz]", null);
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
      nombre   = campos.find(c => c.name === "full_name")?.values?.[0]   || "Cliente";
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
      `Para poder ayudarle mejor, ¿podría contarme un poco más sobre el proyecto que tiene en mente? ` +
      `Por ejemplo: ¿en qué zona está ubicado y cuál sería el alcance del trabajo?`;

    await sendText("+" + telefonoNorm, mensaje);
    console.log(`✅ WhatsApp enviado a +${telefonoNorm}`);

    // Guardar en memoria
    memoria.guardarMensaje({
      phone: "+" + telefonoNorm,
      clientName: nombre !== "Cliente" ? nombre : null,
      direction: "out",
      type: "text",
      content: mensaje,
      session: { project_desc: interes, zone: zona },
    }).catch(e => console.warn("⚠️ No se pudo guardar lead en memoria:", e.message));

    const SUPS = ["+50683091817", "+50671981370", "+50670068477"];
    const notifSup =
      `🔥 *Nuevo lead Meta Ads*\n\n` +
      `👤 Nombre: ${nombre}\n` +
      `📱 Teléfono: +${telefonoNorm}\n` +
      `🔨 Interés: ${interes}\n` +
      `📍 Zona: ${zona}\n\n` +
      `✅ Sasha ya le escribió automáticamente.`;

    for (const sup of SUPS) {
      sendText(sup, notifSup).catch(e => console.warn(`⚠️ No se pudo notificar a ${sup}:`, e.message));
    }

    if (process.env.MAKE_WEBHOOK_META_LEADS) {
      try {
        await fetch(process.env.MAKE_WEBHOOK_META_LEADS, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nombre,
            telefono: "+" + telefonoNorm,
            interes,
            zona,
            fuente: "Meta Ads",
            fecha:  new Date().toLocaleString("es-CR", { timeZone: "America/Costa_Rica" }),
            estado: "Nuevo lead"
          })
        });
        console.log("✅ Lead registrado en CRM via Make");
      } catch (errMake) {
        console.warn("⚠️ No se pudo registrar en CRM:", errMake.message);
      }
    }

    res.json({ ok: true, telefono: "+" + telefonoNorm });

  } catch (err) {
    console.error("❌ Error en /meta-lead:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Manifest PWA ───────────────────────────────────────────────────────────────
app.get("/manifest.json", (_req, res) => {
  res.json({
    name: "SS Remodelaciones",
    short_name: "SSR",
    start_url: "/",
    display: "standalone",
    background_color: "#1B3A6B",
    theme_color: "#D4541A",
    icons: [{ src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='20' fill='%231B3A6B'/%3E%3Ctext y='68' x='50' font-size='55' text-anchor='middle' fill='%23D4541A' font-family='Arial' font-weight='bold'%3ESS%3C/text%3E%3C/svg%3E", sizes: "192x192", type: "image/svg+xml" }]
  });
});

// ── Test de recordatorios ──────────────────────────────────────────────────────
app.get("/test-reminders", async (_req, res) => {
  await sendDailyReminders();
  res.json({ ok: true, message: "Recordatorios ejecutados" });
});

// ── Test de Meta Lead ──────────────────────────────────────────────────────────
app.get("/test-meta-lead", async (req, res) => {
  try {
    const payload = {
      nombre:   req.query.nombre   || "Cliente Prueba",
      telefono: req.query.telefono || "50671951695",
      interes:  req.query.interes  || "Remodelación de cocina",
      zona:     req.query.zona     || "Heredia"
    };
    console.log("🧪 Test Meta Lead:", payload);
    const r = await fetch(`http://localhost:${PORT}/meta-lead`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload)
    });
    const data = await r.json();
    res.json({ ok: true, test: payload, resultado: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Cotizador: procesar notas con IA ─────────────────────────────────────────
app.post("/api/procesar-notas", async (req, res) => {
  try {
    const { notas, fotos, pdfs } = req.body;
    const Anthropic = require("@anthropic-ai/sdk");
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const pdfCtx = (pdfs||[]).length > 0
      ? "\n\nDOCUMENTOS/PLANOS:\n" + pdfs.map(p => "--- " + p.name + " ---\n" + p.text).join("\n\n")
      : "";

    const proyectoGrande = (notas||"").length > 800 || (fotos||[]).length >= 4;

    const instruccionMateriales = proyectoGrande
      ? `MATERIALES: Lista los materiales PRINCIPALES de cada actividad (entre 4-8 por actividad). Incluye los más costosos e importantes. Para consumibles menores (cinta, lija, etc.) agrúpalos en un ítem "Consumibles y herramientas menores" por actividad con precio estimado global. Sé conciso pero preciso.`
      : `CRITICO: Lista TODOS los materiales + herramientas + consumibles para cada actividad. Si es un techo metalico incluye discos de corte, thinner, mechas, brochas, pintura anticorrosiva, etc. No omitas NADA necesario para ejecutar el trabajo desde cero hasta terminado.`;

    const prompt =
      "Analiza las notas, fotos y documentos adjuntos y genera un presupuesto COMPLETO de remodelacion.\n\n" +
      "NOTAS:\n" + (notas || "(ver fotos/documentos)") + pdfCtx +
      "\n\nCOSTOS MO: Operario ₡27.000/dia, Ayudante ₡20.000/dia, Utilidad MO 50%. Maximo 10 actividades." +
      " NO incluyas transporte ni andamios (se agregan automaticamente). SOLO NUMEROS en precios, sin simbolos.\n\n" +
      instruccionMateriales + "\n\n" +
      'RESPONDER SOLO JSON: {"asunto":"texto","items":[{"id":1,"descripcion":"texto","unidad":"Und","cantidad":1,"dias":2,"operarios":1,"ayudantes":1,"materiales":[{"detalle":"texto","und":"Und","cantidad":5,"precio_unitario":3500,"fuente":"Construplaza"}]}]}';

    const systemPrompt = `Sos experto en presupuestos de construccion y remodelacion en Costa Rica. Responde SOLO JSON puro valido sin markdown ni backticks ni simbolos especiales fuera del JSON.

REGLAS:
1. Corrige ortografia y acentos en todas las descripciones.
2. Precios de referencia en Costa Rica: Construplaza, EPA, El Lagar, Mundo Iluminacion, Ferreteria El Colono, Maderas MM, PriceSmart.
3. Si el material es especializado y no esta en esas tiendas, BUSCALO en internet y pon en fuente el sitio donde lo encontraste.
4. Si no encontras precio confiable, pon fuente: "Cotizar".

REGLA CRITICA — MATERIALES EXHAUSTIVOS:
Para CADA actividad incluye ABSOLUTAMENTE TODOS los materiales, herramientas y consumibles necesarios para ejecutarla de principio a fin.`;

    const content = (fotos||[]).length > 0
      ? [...fotos.map(f => ({ type: "image", source: { type: "base64", media_type: f.mimeType, data: f.base64 } })), { type: "text", text: prompt }]
      : prompt;

    function escaparComillasInternas(s) {
      let result = "";
      let inStr = false;
      let esc = false;
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (esc)                    { result += c; esc = false; continue; }
        if (c === "\\" && inStr)    { result += c; esc = true;  continue; }
        if (c === '"') {
          if (!inStr) { inStr = true; result += c; continue; }
          let j = i + 1;
          while (j < s.length && s[j] === " ") j++;
          const next = j < s.length ? s[j] : "";
          if ([":", ",", "}", "]", ""].includes(next)) {
            inStr = false; result += c;
          } else {
            result += '\\"';
          }
        } else {
          result += c;
        }
      }
      return result;
    }

    function parsearJSON(raw) {
      let s = raw
        .replace(/```json/gi, "").replace(/```/g, "").trim()
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'");

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
      if (b < 0) throw new Error("No JSON en respuesta");

      s = s.slice(a, b + 1)
        .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, "")
        .replace(/\r?\n/g, " ")
        .replace(/\t/g, " ")
        .replace(/"precio_unitario"\s*:\s*(\d+),(\d{3})\b/g, '"precio_unitario": $1$2')
        .replace(/"cantidad"\s*:\s*(\d+),(\d{3})\b/g, '"cantidad": $1$2')
        .replace(/,(\s*[}\]])/g, "$1");

      try {
        return JSON.parse(s);
      } catch (e1) {
        try {
          return JSON.parse(escaparComillasInternas(s));
        } catch (e2) {
          try {
            return JSON.parse(escaparComillasInternas(s.replace(/[^\x20-\x7E\u00C0-\u024F\u20A1]/g, " ")));
          } catch (e3) {
            throw new Error(e1.message);
          }
        }
      }
    }

    let data;
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    async function callClaudeWithRetry(opts, label) {
      for (let intento = 1; intento <= 3; intento++) {
        try {
          const r   = await anthropic.messages.create(opts);
          const txt = (r.content || []).filter(b => b.type === "text").map(b => b.text).join("")
                      || r.content?.[0]?.text || "";
          if (!txt) throw new Error("Sin texto en respuesta");
          return parsearJSON(txt);
        } catch (err) {
          const is429 = err.status === 429 || String(err.message).includes("rate_limit");
          if (is429 && intento < 3) {
            const wait = intento === 1 ? 65000 : 35000;
            console.warn(`⚠️ Rate limit 429 en ${label} — reintentando en ${wait/1000}s (intento ${intento}/3)...`);
            await sleep(wait);
          } else {
            throw err;
          }
        }
      }
    }

    const maxTok = 8192;
    try {
      data = await callClaudeWithRetry({
        model: "claude-sonnet-4-6",
        max_tokens: maxTok,
        system: systemPrompt,
        messages: [{ role: "user", content }],
      }, "/api/procesar-notas sin web_search");
      console.log(`✅ /api/procesar-notas OK (sin web_search, max_tokens=${maxTok}, grande=${proyectoGrande})`);
    } catch (e1) {
      console.warn("⚠️  Sin web_search falló (" + e1.message + "), reintentando con web_search...");
      data = await callClaudeWithRetry({
        model: "claude-sonnet-4-6",
        max_tokens: maxTok,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        system: systemPrompt,
        messages: [{ role: "user", content }],
      }, "/api/procesar-notas con web_search");
      console.log(`✅ /api/procesar-notas OK (con web_search, max_tokens=${maxTok})`);
    }

    res.json({ ok: true, data });

  } catch (err) {
    console.error("❌ /api/procesar-notas:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Cotizacion → Drive ─────────────────────────────────────────────────────────
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

// ── Transcripción de voz (endpoint manual para apps externas) ─────────────────
app.post("/api/transcribir-voz", async (req, res) => {
  try {
    const { audio, mimeType } = req.body;
    if (!audio) return res.status(400).json({ ok: false, error: "Sin audio" });

    const Anthropic = require("@anthropic-ai/sdk");
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    try {
      const r = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system: "Sos un asistente que transcribe notas de obras de construccion en Costa Rica. " +
                "Transcribí el audio exactamente como fue dicho, en español. " +
                "Solo devolvé el texto transcrito, sin explicaciones ni formato extra.",
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: mimeType || "audio/webm", data: audio } },
            { type: "text", text: "Transcribí este audio de notas de obra de construccion en Costa Rica." }
          ]
        }]
      });
      const texto = (r.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
      if (texto) {
        console.log("✅ /api/transcribir-voz OK:", texto.slice(0, 60));
        return res.json({ ok: true, texto });
      }
    } catch (e) {
      console.warn("⚠️  Claude no pudo procesar el audio:", e.message);
    }

    res.json({ ok: false, error: "Transcripción no disponible" });

  } catch (err) {
    console.error("🔥 /api/transcribir-voz:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Servir archivos estáticos (cotizador y otros) ─────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ── Endpoint: Enviar mensaje outbound desde CRM o Make ───────────────────────
app.post("/send-message", async (req, res) => {
  try {
    const { telefono, mensaje } = req.body;
    if (!telefono || !mensaje) {
      return res.status(400).json({ ok: false, error: "Faltan telefono y mensaje" });
    }

    let telefonoNorm = telefono.replace(/\D/g, "");
    if (!telefonoNorm.startsWith("506") && telefonoNorm.length === 8) {
      telefonoNorm = "506" + telefonoNorm;
    }

    const { sendText } = require("./bot/messenger");
    await sendText("+" + telefonoNorm, mensaje);
    console.log(`📤 /send-message → +${telefonoNorm}: "${mensaje.substring(0, 60)}"`);

    // ── Guardar en memoria para que aparezca en el CRM al refrescar ──────────
    memoria.guardarMensaje({
      phone: "+" + telefonoNorm,
      clientName: null,
      direction: "out",
      type: "text",
      content: mensaje,
      session: null,
    }).catch(e => console.warn("⚠️ No se pudo guardar en memoria:", e.message));

    res.json({ ok: true, telefono: "+" + telefonoNorm });
  } catch (err) {
    console.error("❌ /send-message error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
┌────────────────────────────────────────────────────────────┐
│  🏗️  SS Remodelaciones ∙ WhatsApp Bot (Sasha)              │
│  🤖  IA: Claude Sonnet 4.6 (visión + audio activados)      │
│  ⏰  Recordatorios: 8:00 AM CR diario                      │
│  🚀  Puerto: ${PORT}                                           │
│  📌  Webhook WhatsApp: GET|POST /webhook                   │
│  🔥  Webhook Meta Leads: GET|POST /meta-lead               │
│  🎙️  Audio interno: transcripción en tiempo real           │
│  🧪  Test leads: GET /test-meta-lead                       │
└────────────────────────────────────────────────────────────┘
  `);
});

module.exports = app;
