require("dotenv").config();
const express = require("express");
const cron    = require("node-cron");
const path    = require("path");
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

// ── Cron: recordatorios 8:00 AM Costa Rica ────────────────────────────────────
cron.schedule("0 8 * * *", async () => {
  console.log("🕐 Cron activado → enviando recordatorios del día...");
  await sendDailyReminders();
}, { timezone: "America/Costa_Rica" });
console.log("✅ Cron de recordatorios registrado (8:00 AM CR diario)");

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
      const from = msg.from, messageId = msg.id;
      if (msg.type === "text") {
        const text = msg.text?.body;
        if (!text) continue;
        console.log(`📨 Texto de +${from}: "${text.substring(0, 80)}"`);
        addToBuffer(from, messageId, text, null);
      } else if (msg.type === "interactive") {
        const text = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || msg.interactive?.button_reply?.title;
        if (!text) continue;
        addToBuffer(from, messageId, text, null);
      } else if (msg.type === "location") {
        const { latitude, longitude, name, address } = msg.location;
        const mapsLink = `https://www.google.com/maps?q=${latitude},${longitude}`;
        const text = name ? `Mi ubicación: ${name}${address ? ", " + address : ""} ⇒ ${mapsLink}` : `Mi ubicación: ${mapsLink}`;
        console.log(`📍 Ubicación de +${from}: ${text}`);
        addToBuffer(from, messageId, text, null);
      } else if (msg.type === "image") {
        const mediaId = msg.image?.id, caption = msg.image?.caption || "";
        console.log(`🖼️  Imagen de +${from} (mediaId: ${mediaId})`);
        addToBuffer(from, messageId, caption || null, mediaId);
      } else if (msg.type === "video") {
        const caption = msg.video?.caption || "";
        const videoContext = caption ? `[El cliente envió un video con el mensaje: "${caption}"]` : "[El cliente envió un video de su proyecto]";
        addToBuffer(from, messageId, videoContext, null);
      } else if (msg.type === "audio") {
        const audioId = msg.audio?.id;
        addToBuffer(from, messageId, "[El cliente envió un mensaje de voz]", null);
        if (audioId) {
          const { sendMediaById } = require("./bot/messenger");
          const SUPS = ["+50683091817", "+50671981370"];
          for (const sup of SUPS) {
            sendMediaById(sup, audioId, "audio").catch(e => console.warn(`⚠️ No se pudo reenviar audio a ${sup}:`, e.message));
          }
          const { sendText: st } = require("./bot/messenger");
          for (const sup of SUPS) {
            st(sup, `🎙️ *Audio de cliente +${from}*`).catch(() => {});
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

// ── Health & status ────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({
  bot: "SS Remodelaciones ∙ Sasha",
  status: "✅ operando",
  api: "Meta WhatsApp Business API",
  features: ["visión de fotos (múltiples)", "análisis de videos", "recordatorios automáticos", "detección de idioma"],
  ts: new Date().toISOString(),
}));

app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ── Cotizador Web App ──────────────────────────────────────────────────────────
app.get("/cotizador", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.sendFile(path.join(__dirname, "public", "cotizador.html"));
});

// PWA manifest
app.get("/cotizador-manifest.json", (_req, res) => {
  res.json({
    name: "Cotizador SSR", short_name: "Cotizador",
    description: "SS Remodelaciones ∙ Sistema de cotizaciones",
    start_url: "/cotizador", display: "standalone",
    background_color: "#F4F6F9", theme_color: "#1B3A6B",
    icons: [{ src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%231B3A6B'/><text y='68' x='50' font-size='55' text-anchor='middle' fill='%23D4541A' font-family='Arial' font-weight='bold'>SS</text></svg>", sizes: "192x192", type: "image/svg+xml" }]
  });
});

app.get("/test-reminders", async (_req, res) => {
  await sendDailyReminders();
  res.json({ ok: true, message: "Recordatorios ejecutados" });
});

// ── Cotizador: procesar notas con IA ─────────────────────────────────────────
// ACTUALIZADO v4: materiales exhaustivos + herramientas + consumibles
app.post("/api/procesar-notas", async (req, res) => {
  try {
    const { notas, fotos, pdfs } = req.body;
    const Anthropic  = require("@anthropic-ai/sdk");
    const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const pdfCtx = (pdfs||[]).length > 0
      ? "\n\nDOCUMENTOS/PLANOS:\n" + pdfs.map(p => "--- " + p.name + " ---\n" + p.text).join("\n\n")
      : "";

    // ── SISTEMA: Reglas de presupuestación exhaustiva ─────────────────────────
    const systemPrompt = `Sos experto en presupuestos de construccion y remodelacion en Costa Rica. Responde SOLO JSON puro valido sin markdown ni backticks ni simbolos especiales fuera del JSON.

REGLAS:
1. Corrige ortografia y acentos en todas las descripciones.
2. Precios de referencia en Costa Rica: Construplaza, EPA, El Lagar, Mundo Iluminacion, Ferreteria El Colono, Maderas MM, PriceSmart.
3. Si el material es especializado y no esta en esas tiendas, BUSCALO en internet y pon en fuente el sitio donde lo encontraste.
4. Si no encontras precio confiable, pon fuente: "Cotizar".

REGLA CRITICA — MATERIALES EXHAUSTIVOS:
Para CADA actividad incluye ABSOLUTAMENTE TODOS los materiales, herramientas y consumibles necesarios para ejecutarla de principio a fin. No solo materiales principales — tambien fijaciones, consumibles, herramientas y equipos.

Ejemplos obligatorios por tipo de obra:
- Techo tubo acero/policarbonato: tubos HN, laminas policarbonato, tornillos autoperforantes techo, disco de corte metal, thinner, mecha para metal, brocha, rodillo, pintura anticorrosiva, sellador de techo, nivel.
- Pintura paredes: pintura latex/aceite, rodillos, brochas anguladas, bandeja para pintura, cinta de enmascarar, plastico protector de piso, lija No.80 y No.120, masilla, espatula, diluyente.
- Ceramica/enchape: ceramicas, pegamento tipo A, fragua color, crucetas 2mm, nivel, cortadora ceramica o disco de corte, esponja, cubo, silicone para esquinas.
- Plomeria: tuberias, codos 90 y 45, tees, union, teflón, pegamento PVC, lija para PVC, llave de paso, soporte de tubo.
- Cielo raso gypsum: laminas gypsum, perfileria metalica (canal y liston), tornillos fosfatados, taco fisher, cinta de papel, masilla lista uso, lija, pintura base.
- Madera/carpinteria: madera, tornillos, pegamento PVC/madera, lija, barniz, sellador, brocha.
- Electricidad: cable TTU, tubo conduit, conectores, cinta aislante, breaker, cajas conduit, tornillos.
- Pintura exterior/fachada: pintura exterior, impermeabilizante, rodillo de esponja, brocha, cinta, plastico, lija, sellador de grietas.

NUNCA agrega texto, comentarios, notas ni nada fuera del JSON. La respuesta es EXCLUSIVAMENTE el objeto JSON, sin nada antes ni despues.
CRITICO — COMILLAS EN TEXTO: NUNCA uses el simbolo " dentro de valores de texto. Para medidas en pulgadas escribe "plg" o "pulgadas" (ej: "Track 3.5 plg" NO "Track 3.5\""). Para citar marcas o calidades usa parentesis (ej: "ceramica (rectificada) 60x60" NO "ceramica \"rectificada\" 60x60"). Cualquier comilla interna en un string rompe el JSON.
NO incluyas "transporte", "limpieza" ni "andamios" — esos se agregan automaticamente aparte.`;

    // ── Detectar tamaño del proyecto para ajustar nivel de detalle ───────────
    const notasParaContar = notas || "";
    const contadorActividades = (notasParaContar.match(/\b(instalar|cambiar|pintar|demoler|construir|colocar|hacer|reparar|ampliar|enchap|cielorraso|cielo raso|gypsum|techo|piso|puerta|ventana|baño|cocina|pared|fachada|piscina)\b/gi) || []).length;
    const proyectoGrande = contadorActividades > 5 || notasParaContar.length > 800;

    const instruccionMateriales = proyectoGrande
      ? `MATERIALES: Lista los materiales PRINCIPALES de cada actividad (entre 4-8 por actividad). Incluye los más costosos e importantes. Para consumibles menores (cinta, lija, etc.) agrúpalos en un ítem "Consumibles y herramientas menores" por actividad con precio estimado global. Sé conciso pero preciso.`
      : `CRITICO: Lista TODOS los materiales + herramientas + consumibles para cada actividad. Si es un techo metalico incluye discos de corte, thinner, mechas, brochas, pintura anticorrosiva, etc. No omitas NADA necesario para ejecutar el trabajo desde cero hasta terminado.`;

    // ── PROMPT DE USUARIO ─────────────────────────────────────────────────────
    const prompt =
      "Analiza las notas, fotos y documentos adjuntos y genera un presupuesto COMPLETO de remodelacion.\n\n" +
      "NOTAS:\n" + (notas || "(ver fotos/documentos)") + pdfCtx +
      "\n\nCOSTOS MO: Operario ₡27.000/dia, Ayudante ₡20.000/dia, Utilidad MO 50%. Maximo 10 actividades." +
      " NO incluyas transporte ni andamios (se agregan automaticamente). SOLO NUMEROS en precios, sin simbolos.\n\n" +
      instruccionMateriales + "\n\n" +
      'RESPONDER SOLO JSON: {"asunto":"texto","items":[{"id":1,"descripcion":"texto","unidad":"Und","cantidad":1,"dias":2,"operarios":1,"ayudantes":1,"materiales":[{"detalle":"texto","und":"Und","cantidad":5,"precio_unitario":3500,"fuente":"Construplaza"}]}]}';

    const content = (fotos||[]).length > 0
      ? [...fotos.map(f => ({ type: "image", source: { type: "base64", media_type: f.mimeType, data: f.base64 } })), { type: "text", text: prompt }]
      : prompt;

    // ── Limpieza robusta del JSON ─────────────────────────────────────────────
    // FIX DEFINITIVO v5:
    //  1. Brace-counting para ignorar cualquier texto de Claude despues del JSON
    //  2. Escape de comillas internas en strings (ej: Track 3.5" o Tornillo 1/2")
    //     → causa del error "Expected ':'" cuando Claude usa pulgadas en descripciones
    //  3. Fix de precios con separador de miles (16,000 → 16000)

    // Paso A: escapa comillas internas mal puestas dentro de strings JSON
    // Lógica: si después de una " viene algo distinto a : , } ] entonces es comilla interna
    function escaparComillasInternas(s) {
      let result = "";
      let inStr = false;
      let esc = false;
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (esc)              { result += c; esc = false; continue; }
        if (c === "\\" && inStr) { result += c; esc = true;  continue; }
        if (c === '"') {
          if (!inStr) { inStr = true;  result += c; continue; }
          // ¿Es comilla de cierre legítima?
          // Miramos el siguiente caracter no-espacio
          let j = i + 1;
          while (j < s.length && s[j] === " ") j++;
          const next = j < s.length ? s[j] : "";
          if ([":", ",", "}", "]", ""].includes(next)) {
            inStr = false; result += c; // cierre legítimo
          } else {
            result += '\\"'; // comilla interna → escaparla
          }
        } else {
          result += c;
        }
      }
      return result;
    }

    function parsearJSON(raw) {
      // Reemplazar comillas tipográficas por rectas
      let s = raw
        .replace(/```json/gi, "").replace(/```/g, "").trim()
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'");

      const a = s.indexOf("{");
      if (a < 0) throw new Error("No JSON en respuesta");

      // Brace-counting: encontrar el cierre REAL del objeto JSON raíz
      let depth = 0, b = -1, inStr = false, esc = false;
      for (let i = a; i < s.length; i++) {
        const c = s[i];
        if (esc)           { esc = false; continue; }
        if (c === "\\" && inStr) { esc = true;  continue; }
        if (c === '"')     { inStr = !inStr; continue; }
        if (inStr)         continue;
        if (c === "{")     depth++;
        else if (c === "}") { depth--; if (depth === 0) { b = i; break; } }
      }
      if (b < 0) b = s.lastIndexOf("}"); // fallback si JSON truncado
      if (b < 0) throw new Error("No JSON en respuesta");

      s = s.slice(a, b + 1)
        .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, "")
        .replace(/\r?\n/g, " ")
        .replace(/\t/g, " ")
        // Corrige precios con separador de miles: 16,000 → 16000
        .replace(/"precio_unitario"\s*:\s*(\d+),(\d{3})\b/g, '"precio_unitario": $1$2')
        .replace(/"cantidad"\s*:\s*(\d+),(\d{3})\b/g, '"cantidad": $1$2')
        .replace(/,(\s*[}\]])/g, "$1");

      // Intento 1: parseo directo
      try {
        return JSON.parse(s);
      } catch (e1) {
        // Intento 2: escapar comillas internas (ej: 3.5" de pulgadas en descripciones)
        try {
          const sFixed = escaparComillasInternas(s);
          return JSON.parse(sFixed);
        } catch (e2) {
          // Intento 3: eliminar todo lo que no sea ASCII básico y reintentar
          try {
            const sAscii = s.replace(/[^\x20-\x7E\u00C0-\u024F\u20A1]/g, " ");
            return JSON.parse(escaparComillasInternas(sAscii));
          } catch (e3) {
            throw new Error(e1.message); // lanzar el error original
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

    // max_tokens siempre al máximo — proyectos con materiales exhaustivos generan JSONs grandes
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


// ── Transcripción de voz ───────────────────────────────────────────────────────
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
        system: "Sos un asistente que transcribe notas de obras de construccion en Costa Rica. Transcribí el audio exactamente como fue dicho, en español. Solo devolvé el texto transcrito, sin explicaciones ni formato extra.",
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

    res.json({ ok: false, error: "Transcripción no disponible — audio descargado localmente" });

  } catch (err) {
    console.error("🔥 /api/transcribir-voz:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`
┌────────────────────────────────────────────────────────────┐
│  🏗️  SS Remodelaciones ∙ WhatsApp Bot (Sasha)              │
│  🤖  IA: Claude Sonnet 4.6 (visión activada)               │
│  ⏰  Recordatorios: 8:00 AM CR diario                      │
│  🚀  Puerto: ${PORT}                                           │
│  📌  Webhook: GET|POST /webhook                            │
└────────────────────────────────────────────────────────────┘
  `);
});

module.exports = app;
