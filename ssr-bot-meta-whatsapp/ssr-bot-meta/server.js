require("dotenv").config();
const express = require("express");
const cron    = require("node-cron");
const path    = require("path");
const { handleMessage, pausarConversacion, reanudarConversacion, estaEnPausaManual, msRestantesPausa } = require("./bot/index");
const { sendDailyReminders }  = require("./bot/reminders");
const { enviarConfirmacionesVisitasManana } = require("./bot/confirmaciones");
const memoria                 = require("./bot/memoria");

// ══════════════════════════════════════════════════════════════════════════════
// v21 (23 sept 2026) — MENSAJES MANUALES DESDE EL CRM/ERP QUE "NO LLEGABAN"
//
// SÍNTOMA: desde el chat del ERP se mandó "prueba de envio" a José Mata
// (+506 7006-8477). El ERP lo mostró como enviado, quedó guardado en
// MENSAJES, la pausa de Sasha se activó… pero el mensaje nunca llegó al
// teléfono.
//
// CAUSA RAÍZ: regla de WhatsApp Business (Meta), no del ERP. Un mensaje de
// texto libre solo se entrega si el cliente escribió en las últimas 24
// horas ("ventana de atención"). El último mensaje de ese número fue el
// jueves 17 a las 15:50 — 6 días antes. Fuera de esa ventana, Meta ACEPTA
// la llamada (responde 200 con un ID de mensaje) y recién DESPUÉS manda un
// aviso de fallo (error 131047) por el webhook como "status". Este servidor
// ignoraba todos los "statuses" del webhook, así que el fallo era invisible:
// /send-message respondía ok:true y el mensaje se perdía sin rastro.
// "Antes funcionaba" porque las pruebas anteriores se hicieron con clientes
// que habían escrito ese mismo día.
//
// FIX:
//   1. /send-message revisa ANTES de enviar cuándo fue el último mensaje
//      entrante del cliente (hoja MENSAJES). Si pasaron más de 24 h, NO
//      manda el texto (se perdería) y devuelve un error claro que el ERP y
//      el CRM muestran en pantalla. El texto queda en el cuadro de redacción.
//   2. Si configurás una plantilla aprobada en Railway
//      (WA_PLANTILLA_REAPERTURA = "nombre_plantilla|es"), en ese caso se
//      envía la plantilla para reabrir la conversación; cuando el cliente
//      responda, ya se le puede escribir libremente.
//   3. El webhook ahora procesa los "statuses": si WhatsApp avisa que un
//      mensaje NO se entregó (por cualquier motivo), queda en los logs y se
//      registra en MENSAJES como "⚠️ WhatsApp no entregó…", visible en el
//      chat del CRM/ERP.
// ══════════════════════════════════════════════════════════════════════════════

const VENTANA_WHATSAPP_MS = 24 * 60 * 60 * 1000;
const WA_API_VERSION      = process.env.WHATSAPP_API_VERSION || "v21.0";

// ── KEEP-ALIVE: evita que Railway duerma el proceso ─────────────────────────────
// Self-ping cada 14 min — sin archivo externo, todo inline.
(function iniciarKeepAlive() {
  const PING_MS = 14 * 60 * 1000;
  function getUrl() {
    const d = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.BOT_URL || null;
    if (!d) return null;
    let u = d.trim().replace(/\/+$/, "");
    return (u.startsWith("http") ? u : "https://" + u) + "/health";
  }
  async function ping() {
    const url = getUrl();
    if (!url) return;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      console.log("💓 KeepAlive: OK", r.status, new Date().toLocaleString("es-CR", { timeZone: "America/Costa_Rica" }));
    } catch (e) {
      console.warn("⚠️ KeepAlive ping falló:", e.message);
    }
  }
  const url = getUrl();
  if (!url) {
    console.warn("⚠️ KeepAlive: agregá BOT_URL=https://ssr-whatsapp-bot-production.up.railway.app en Railway Variables");
    return;
  }
  console.log("💓 KeepAlive activo — ping cada 14 min a:", url);
  setTimeout(ping, 5000);
  setInterval(ping, PING_MS);
})();

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

// ── Cron: confirmación de visitas de mañana, 7:00 PM Costa Rica ───────────────
// v18 — la noche anterior a cada visita agendada, recordatorio con botones
// Sí/No. Ver bot/confirmaciones.js.
cron.schedule("0 19 * * *", async () => {
  console.log("🕖 Cron activado → enviando confirmaciones de visitas de mañana...");
  await enviarConfirmacionesVisitasManana();
}, { timezone: "America/Costa_Rica" });
console.log("✅ Cron de confirmaciones de visita registrado (7:00 PM CR diario)");

// ── Números internos (supervisores / Melvin) ──────────────────────────────────
const NUMEROS_INTERNOS = new Set([
  "50683091817",  // Darwin
  "50671981370",  // Melvin
  "50670068477",  // Oficina SSR (WhatsApp corporativo Solo Senso S.A.)
]);

// ═══════════════════════════════════════════════════════════════════════════════
// FIX v7 — ANTI-LOOP DE LEADS (bucle Make ↔ /meta-lead)
//   1. Marcador de origen "sasha-bot" en el POST a Make: si vuelve, se ignora.
//   2. Deduplicación por teléfono: mismo teléfono dentro de 10 min se ignora.
//   3. /meta-lead responde 200 inmediato para que Make nunca reintente.
// ═══════════════════════════════════════════════════════════════════════════════

const leadsRecientes    = new Map();           // telefonoNorm → timestamp
const LEAD_DEDUP_MS     = 10 * 60 * 1000;      // ventana de 10 minutos

function esLeadDuplicado(telefonoNorm) {
  const ahora  = Date.now();
  for (const [tel, ts] of leadsRecientes) {
    if (ahora - ts > LEAD_DEDUP_MS) leadsRecientes.delete(tel);
  }
  const ultimo = leadsRecientes.get(telefonoNorm);
  if (ultimo && ahora - ultimo < LEAD_DEDUP_MS) return true;
  leadsRecientes.set(telefonoNorm, ahora);
  return false;
}

// ── Normalizar teléfono CR a "506XXXXXXXX" ────────────────────────────────────
function normalizarTelefono(telefono) {
  let t = String(telefono || "").replace(/\D/g, "");
  if (!t.startsWith("506") && t.length === 8) t = "506" + t;
  return t;
}

// ═══════════════════════════════════════════════════════════════════════════════
// v21 — VENTANA DE 24 H DE WHATSAPP
// ═══════════════════════════════════════════════════════════════════════════════

// Último mensaje ENTRANTE (del cliente) guardado en MENSAJES. null si nunca
// escribió. Lanza error si no se pudo leer la hoja (el llamador decide).
async function ultimoMensajeEntrante(telefonoNorm) {
  const filas = await memoria.buscarPorTelefono(telefonoNorm, 1000);
  let ultimo = null;
  for (const r of filas) {
    if (String(r[3] || "").trim().toLowerCase() !== "in") continue;
    const d = new Date(r[0]);
    if (!isNaN(d.getTime()) && (!ultimo || d > ultimo)) ultimo = d;
  }
  return ultimo;
}

function describirTiempo(ms) {
  const h = Math.floor(ms / 3600000);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} días`;
}

// Envía la plantilla aprobada configurada en WA_PLANTILLA_REAPERTURA
// ("nombre|idioma", idioma por defecto "es"). Debe ser una plantilla SIN
// variables. Devuelve { enviada, nombre?, motivo? }.
async function enviarPlantillaReapertura(telefonoNorm) {
  const conf = String(process.env.WA_PLANTILLA_REAPERTURA || "").trim();
  if (!conf) return { enviada: false, motivo: "sin_plantilla_configurada" };

  const [nombre, idioma] = conf.split("|").map(s => (s || "").trim());
  try {
    const r = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: telefonoNorm,
        type: "template",
        template: { name: nombre, language: { code: idioma || "es" } },
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { enviada: false, nombre, motivo: data?.error?.message || `HTTP ${r.status}` };
    return { enviada: true, nombre };
  } catch (err) {
    return { enviada: false, nombre, motivo: err.message };
  }
}

// Texto explicativo según el código de error que manda WhatsApp.
function explicarErrorEntrega(code) {
  const c = Number(code);
  if (c === 131047) return "pasaron más de 24 h desde el último mensaje del cliente; WhatsApp solo permite plantillas aprobadas";
  if (c === 131026) return "el número no tiene WhatsApp o no puede recibir mensajes";
  if (c === 131049) return "WhatsApp limitó el envío a este cliente para cuidar la calidad de la cuenta";
  if (c === 131051) return "tipo de mensaje no soportado";
  if (c === 131031) return "la cuenta de WhatsApp Business está restringida";
  if (c === 130472) return "el cliente está en un experimento de Meta y no recibe mensajes de marketing";
  return "";
}

// Deduplicación de avisos de fallo (Meta puede reintentar el mismo webhook).
const fallosRegistrados = new Map(); // wamid → timestamp
function yaRegistradoFallo(id) {
  const ahora = Date.now();
  for (const [k, ts] of fallosRegistrados) if (ahora - ts > 6 * 3600000) fallosRegistrados.delete(k);
  if (fallosRegistrados.has(id)) return true;
  fallosRegistrados.set(id, ahora);
  return false;
}

// Procesa los "statuses" del webhook: sent / delivered / read / failed.
// Solo los "failed" dejan rastro (log + fila en MENSAJES).
function procesarEstadosWhatsApp(statuses) {
  for (const s of statuses || []) {
    if (s.status !== "failed") continue;
    if (s.id && yaRegistradoFallo(s.id)) continue;

    const err     = (s.errors && s.errors[0]) || {};
    const code    = err.code || "";
    const titulo  = err.title || err.message || "error desconocido";
    const detalle = err.error_data?.details || "";
    const phone   = "+" + String(s.recipient_id || "").replace(/\D/g, "");
    const explic  = explicarErrorEntrega(code);

    console.error(`❌ WhatsApp NO entregó mensaje a ${phone} — [${code}] ${titulo}${detalle ? " · " + detalle : ""} (id ${s.id})`);

    memoria.guardarMensaje({
      phone,
      clientName: null,
      direction: "out",
      type: "text",
      content: `⚠️ WhatsApp no entregó el mensaje anterior${code ? ` (error ${code})` : ""}: ${explic || titulo}.`,
      session: null,
    }).catch(e => console.warn("⚠️ No se pudo registrar el fallo de entrega en memoria:", e.message));
  }
}

// ── Transcripción de audio vía OpenAI Whisper ─────────────────────────────────
async function transcribirAudio(audioId, esInterno) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("❌ transcribirAudio: falta OPENAI_API_KEY en variables de entorno");
      return null;
    }

    const { downloadMedia } = require("./bot/messenger");
    const { base64, mimeType } = await downloadMedia(audioId);

    if (!base64) {
      console.error("❌ transcribirAudio: descarga de audio vacía");
      return null;
    }

    const buffer = Buffer.from(base64, "base64");
    const mime   = mimeType || "audio/ogg";
    const ext    = mime.includes("mpeg") ? "mp3"
                 : mime.includes("mp4")  ? "mp4"
                 : mime.includes("wav")  ? "wav"
                 : mime.includes("webm") ? "webm"
                 : "ogg";

    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mime }), `audio.${ext}`);
    form.append("model", "whisper-1");
    form.append("language", "es");
    form.append("response_format", "json");
    form.append(
      "prompt",
      esInterno
        ? "Instrucción interna de SS Remodelaciones en Costa Rica. Vocabulario: gasto, ingreso, " +
          "planilla, proyecto, materiales, colones, visita técnica, cliente, Darwin, Melvin, Oficina SSR."
        : "Mensaje de un cliente de SS Remodelaciones en Costa Rica sobre remodelación, " +
          "construcción, pintura, gypsum, cocina, baño."
    );

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method:  "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body:    form,
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      console.error(`❌ Whisper error ${resp.status}:`, errBody.slice(0, 300));
      return null;
    }

    const data  = await resp.json();
    const texto = (data?.text || "").trim();
    return texto || null;

  } catch (err) {
    console.error("❌ Error en transcribirAudio:", err.message);
    return null;
  }
}

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

// ── HEALTH CHECK — requerido por keepalive ────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status:   "ok",
    service:  "Sasha SSR",
    ts:       new Date().toISOString(),
    sessions: "active",
  });
});

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

    const value = body.entry?.[0]?.changes?.[0]?.value;

    // v21 — avisos de entrega (antes se ignoraban por completo).
    if (value?.statuses?.length) procesarEstadosWhatsApp(value.statuses);

    const messages = value?.messages;
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

      } else if (msg.type === "button") {
        // Respuesta a un botón de PLANTILLA (p. ej. la plantilla de
        // reapertura): llega como msg.button, no como interactive.
        const text = msg.button?.payload || msg.button?.text;
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

            // v20 — guardar el audio original (con driveUrl) para clientes,
            // además de la transcripción, para que el CRM muestre el audio.
            if (!esInterno) {
              memoria.guardarAdjuntoCliente({
                phone: "+" + from,
                clientName: null,
                mediaId: audioId,
                tipo: "audio",
                contenido: transcripcion || "[Audio enviado por el cliente]",
              }).catch(e => console.warn("⚠️ No se pudo guardar audio de cliente en memoria:", e.message));
            }

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

      } else if (msg.type === "document") {
        // v20 — PDFs y documentos de clientes se guardan en memoria (con
        // driveUrl) para verlos en el CRM. Sasha no interpreta el contenido;
        // si trae caption, ese texto sí se procesa normal.
        const mediaId  = msg.document?.id;
        const filename = msg.document?.filename || "documento";
        const caption  = msg.document?.caption || "";
        const esInterno = NUMEROS_INTERNOS.has(from);

        console.log(`📄 Documento de +${from}: "${filename}" (mediaId: ${mediaId}, interno: ${esInterno})`);

        if (mediaId && !esInterno) {
          memoria.guardarAdjuntoCliente({
            phone: "+" + from,
            clientName: null,
            mediaId,
            tipo: "document",
            contenido: `[Documento: ${filename}]${caption ? " " + caption : ""}`,
          }).catch(e => console.warn("⚠️ No se pudo guardar documento de cliente en memoria:", e.message));
        }

        if (caption) addToBuffer(from, messageId, caption, null);

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
  // FIX v7 (capa 3): responder 200 JSON INMEDIATAMENTE.
  res.status(200).json({ ok: true });

  try {
    const body = req.body;

    // FIX v7 (capa 1): ignorar nuestro propio eco.
    if (body?.origen === "sasha-bot" || body?.fuente === "Meta Ads") {
      console.log("🔁 Lead ignorado: eco del propio bot (origen sasha-bot / fuente Meta Ads). Anti-loop v7.");
      return;
    }

    console.log("🔥 Nuevo lead Meta recibido:", JSON.stringify(body, null, 2));

    let nombre, telefono, interes, zona;

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
      console.warn("⚠️ Lead recibido sin teléfono — descartado");
      return;
    }

    const telefonoNorm = normalizarTelefono(telefono);

    // FIX v7 (capa 2): deduplicación por teléfono (ventana 10 min).
    if (esLeadDuplicado(telefonoNorm)) {
      console.log(`🔁 Lead duplicado ignorado: +${telefonoNorm} (ya procesado hace <10 min). Anti-loop v7.`);
      return;
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

    // FIX v7: el POST de registro a Make lleva marcador de origen anti-loop.
    if (process.env.MAKE_WEBHOOK_META_LEADS) {
      try {
        await fetch(process.env.MAKE_WEBHOOK_META_LEADS, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            origen:   "sasha-bot",
            nombre,
            telefono: "+" + telefonoNorm,
            interes,
            zona,
            fuente: "Meta Ads",
            fecha:  new Date().toLocaleString("es-CR", { timeZone: "America/Costa_Rica" }),
            estado: "Nuevo lead"
          })
        });
        console.log("✅ Lead registrado en CRM via Make (con marcador anti-loop)");
      } catch (errMake) {
        console.warn("⚠️ No se pudo registrar en CRM:", errMake.message);
      }
    }

  } catch (err) {
    console.error("❌ Error en /meta-lead:", err.message);
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

// ── Test de confirmaciones de visita ────────────────────────────────────────────
app.get("/test-confirmaciones-visita", async (_req, res) => {
  await enviarConfirmacionesVisitasManana();
  res.json({ ok: true, message: "Confirmaciones de visita ejecutadas" });
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

// ── Cotizador: procesar notas con IA ──────────────────────────────────────────
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

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("❌ /api/transcribir-voz: falta OPENAI_API_KEY");
      return res.status(500).json({ ok: false, error: "Transcripción no configurada (falta OPENAI_API_KEY)" });
    }

    const buffer = Buffer.from(audio, "base64");
    const mime   = mimeType || "audio/webm";
    const ext    = mime.includes("mpeg") ? "mp3"
                 : mime.includes("mp4")  ? "mp4"
                 : mime.includes("wav")  ? "wav"
                 : mime.includes("ogg")  ? "ogg"
                 : "webm";

    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mime }), `nota.${ext}`);
    form.append("model", "whisper-1");
    form.append("language", "es");
    form.append("response_format", "json");
    form.append("prompt", "Notas de obra de construcción en Costa Rica: materiales, medidas, metros, colones, cliente, proyecto.");

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method:  "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body:    form,
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      console.warn("⚠️  Whisper no pudo procesar el audio:", errBody.slice(0, 200));
      return res.json({ ok: false, error: "Transcripción no disponible" });
    }

    const data  = await resp.json();
    const texto = (data?.text || "").trim();

    if (texto) {
      console.log("✅ /api/transcribir-voz OK:", texto.slice(0, 60));
      return res.json({ ok: true, texto });
    }

    res.json({ ok: false, error: "Transcripción vacía" });

  } catch (err) {
    console.error("🔥 /api/transcribir-voz:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Cotizador Web App ───────────────────────────────────────────────────────────
app.get("/cotizador", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.sendFile(path.join(__dirname, "public", "cotizador.html"));
});

// ── Servir archivos estáticos ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ── Endpoint: Enviar mensaje outbound desde CRM / ERP / Make ─────────────────
app.post("/send-message", async (req, res) => {
  try {
    const { telefono, mensaje } = req.body;
    if (!telefono || !mensaje) {
      return res.status(400).json({ ok: false, error: "Faltan telefono y mensaje" });
    }

    const telefonoNorm = normalizarTelefono(telefono);
    const tel = "+" + telefonoNorm;

    // ── v21: revisar la ventana de 24 h ANTES de enviar ─────────────────────
    let ultimoEntrante = null;
    let ventanaVerificada = false;
    try {
      ultimoEntrante = await ultimoMensajeEntrante(telefonoNorm);
      ventanaVerificada = true;
    } catch (errVentana) {
      // Si no se pudo leer MENSAJES, no bloqueamos: se intenta el envío y,
      // si WhatsApp lo rechaza, el aviso llega igual por el webhook.
      console.warn(`⚠️ /send-message: no se pudo verificar la ventana de 24 h de ${tel}:`, errVentana.message);
    }

    const fueraDeVentana = ventanaVerificada &&
      (!ultimoEntrante || Date.now() - ultimoEntrante.getTime() > VENTANA_WHATSAPP_MS);

    if (fueraDeVentana) {
      const hace = ultimoEntrante
        ? `hace ${describirTiempo(Date.now() - ultimoEntrante.getTime())}`
        : "nunca";
      console.warn(`⛔ /send-message → ${tel}: fuera de la ventana de 24 h (último mensaje del cliente: ${hace}). Texto NO enviado.`);

      const plantilla = await enviarPlantillaReapertura(telefonoNorm);

      if (plantilla.enviada) {
        memoria.guardarMensaje({
          phone: tel, clientName: null, direction: "out", type: "text",
          content: `[Plantilla de WhatsApp enviada: ${plantilla.nombre}]`, session: null,
        }).catch(() => {});
        console.log(`📨 Plantilla de reapertura "${plantilla.nombre}" enviada a ${tel}`);

        return res.status(409).json({
          ok: false,
          fueraDeVentana: true,
          plantillaEnviada: plantilla.nombre,
          error:
            `El cliente escribió por última vez ${hace}. WhatsApp no permite mensajes libres después de 24 h, ` +
            `así que tu texto NO se envió. Se le mandó la plantilla "${plantilla.nombre}" para reabrir la conversación: ` +
            `cuando responda, volvé a enviar tu mensaje.`,
        });
      }

      return res.status(409).json({
        ok: false,
        fueraDeVentana: true,
        error:
          `El cliente escribió por última vez ${hace}. WhatsApp solo entrega mensajes libres dentro de las 24 h ` +
          `siguientes al último mensaje del cliente, así que tu texto NO se envió. ` +
          (plantilla.motivo === "sin_plantilla_configurada"
            ? `Para reabrir la conversación hace falta una plantilla aprobada (configurá WA_PLANTILLA_REAPERTURA en Railway) ` +
              `o escribile desde el WhatsApp de la oficina.`
            : `Además falló la plantilla de reapertura: ${plantilla.motivo}.`),
      });
    }

    // ── Dentro de la ventana: enviar normal ──────────────────────────────────
    const { sendText } = require("./bot/messenger");
    await sendText(tel, mensaje);
    console.log(`📤 /send-message → ${tel}: "${mensaje.substring(0, 60)}"`);

    memoria.guardarMensaje({
      phone: tel,
      clientName: null,
      direction: "out",
      type: "text",
      content: mensaje,
      session: null,
    }).catch(e => console.warn("⚠️ No se pudo guardar en memoria:", e.message));

    // v20 — cada mensaje manual pausa/renueva a Sasha 60 min con ese cliente.
    const expiraEn = pausarConversacion(tel);

    res.json({ ok: true, telefono: tel, pausadoHasta: expiraEn });
  } catch (err) {
    console.error("❌ /send-message error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Control manual de conversación (Darwin toma/devuelve el control) ─────────
// v20 — botón "Tomar control" / "Devolver a Sasha" del CRM/ERP.

app.post("/api/conversacion/tomar-control", (req, res) => {
  try {
    const { telefono } = req.body;
    if (!telefono) return res.status(400).json({ ok: false, error: "Falta telefono" });

    const tel = "+" + normalizarTelefono(telefono);
    const expiraEn = pausarConversacion(tel);
    console.log(`⏸️ /api/conversacion/tomar-control → ${tel}`);

    res.json({ ok: true, telefono: tel, pausadoHasta: expiraEn });
  } catch (err) {
    console.error("❌ /api/conversacion/tomar-control error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/conversacion/liberar-control", (req, res) => {
  try {
    const { telefono } = req.body;
    if (!telefono) return res.status(400).json({ ok: false, error: "Falta telefono" });

    const tel = "+" + normalizarTelefono(telefono);
    reanudarConversacion(tel);
    console.log(`▶️ /api/conversacion/liberar-control → ${tel}`);

    res.json({ ok: true, telefono: tel });
  } catch (err) {
    console.error("❌ /api/conversacion/liberar-control error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET para que el CRM pinte el estado sin adivinar. v21: además informa si la
// conversación está dentro de la ventana de 24 h de WhatsApp.
app.get("/api/conversacion/estado", async (req, res) => {
  try {
    const telefono = req.query.telefono;
    if (!telefono) return res.status(400).json({ ok: false, error: "Falta telefono" });

    const telefonoNorm = normalizarTelefono(telefono);
    const tel = "+" + telefonoNorm;

    const pausado    = estaEnPausaManual(tel);
    const msRestante = msRestantesPausa(tel);

    let ventana = null;
    try {
      const ultimo = await ultimoMensajeEntrante(telefonoNorm);
      ventana = {
        abierta: !!ultimo && Date.now() - ultimo.getTime() <= VENTANA_WHATSAPP_MS,
        ultimoMensajeCliente: ultimo ? ultimo.toISOString() : null,
        cierraEn: ultimo ? new Date(ultimo.getTime() + VENTANA_WHATSAPP_MS).toISOString() : null,
      };
    } catch (e) {
      ventana = null;
    }

    res.json({
      ok: true,
      telefono: tel,
      pausado,
      pausadoHasta: pausado ? Date.now() + msRestante : null,
      ventana,
    });
  } catch (err) {
    console.error("❌ /api/conversacion/estado error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
┌────────────────────────────────────────────────────────────┐
│  🏗️  SS Remodelaciones ∙ WhatsApp Bot (Sasha)              │
│  🤖  IA: Claude Sonnet 4.6 (visión) + Whisper (audio)      │
│  ⏰  Recordatorios: 8:00 AM CR diario                      │
│  📋  Confirmación visitas: 7:00 PM CR diario                │
│  💓  KeepAlive: ping cada 14 min (siempre activa)          │
│  🛡️  Anti-loop leads v7: dedup 10 min + marcador origen    │
│  🪟  Ventana 24 h WhatsApp: verificada en /send-message    │
│  🚀  Puerto: ${PORT}                                           │
│  📌  Webhook WhatsApp: GET|POST /webhook                   │
│  🔥  Webhook Meta Leads: GET|POST /meta-lead               │
│  🎙️  Audio interno: transcripción en tiempo real           │
│  🧾  Cotizador: GET /cotizador                              │
│  🩺  Health check: GET /health                             │
│  🎛️  Control manual: POST /api/conversacion/tomar-control  │
└────────────────────────────────────────────────────────────┘
  `);
  console.log(`📨 Plantilla de reapertura: ${process.env.WA_PLANTILLA_REAPERTURA ? process.env.WA_PLANTILLA_REAPERTURA : "no configurada (WA_PLANTILLA_REAPERTURA)"}`);
});

module.exports = app;
