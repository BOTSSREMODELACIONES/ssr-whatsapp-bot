/**
 * audio_handler.js — Transcripción de audios nativos de WhatsApp
 * SS Remodelaciones — Sasha Bot
 *
 * Convierte mensajes de voz/audio en texto usando OpenAI Whisper,
 * luego los pasa al flujo normal de handleMessage como si fueran texto.
 *
 * FLUJO:
 *  Admin envía audio: "Sasha, Marriot pagó el adelanto del 50%, agregalo"
 *    → downloadAudio() descarga el OGG de WhatsApp
 *    → transcribeAudio() lo manda a Whisper → texto
 *    → Se pasa el texto a handleMessage() normalmente
 *    → finanzas.js / outbound.js lo procesan igual que texto escrito
 */

const https  = require("https");
const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const os     = require("os");
const { FormData, File } = require("formdata-node"); // npm install formdata-node
// Alternativa si no está disponible: usar form-data clásico

// ── Descargar audio desde Meta API ───────────────────────────────────────────
/**
 * Descarga el audio de WhatsApp a un archivo temporal.
 * @param {string} mediaId - ID del media en WhatsApp
 * @returns {Promise<{filePath: string, mimeType: string}>}
 */
async function downloadAudio(mediaId) {
  const token   = process.env.WHATSAPP_TOKEN;
  const version = process.env.WHATSAPP_API_VERSION || "v19.0";

  // 1. Obtener URL del audio
  const metaUrl = `https://graph.facebook.com/${version}/${mediaId}`;
  const metaInfo = await httpGetJSON(metaUrl, token);

  if (!metaInfo.url) throw new Error(`No URL para media ${mediaId}: ${JSON.stringify(metaInfo)}`);

  // 2. Descargar el archivo
  const tmpFile = path.join(os.tmpdir(), `sasha_audio_${mediaId}.ogg`);
  await downloadFile(metaInfo.url, tmpFile, token);

  return { filePath: tmpFile, mimeType: metaInfo.mime_type || "audio/ogg" };
}

// ── Transcribir con OpenAI Whisper ────────────────────────────────────────────
/**
 * Envía el archivo de audio a Whisper y retorna el texto transcrito.
 * @param {string} filePath - ruta local del archivo de audio
 * @param {string} mimeType - mime type del audio
 * @returns {Promise<string>} texto transcrito
 */
async function transcribeAudio(filePath, mimeType = "audio/ogg") {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY no configurada");

  const fileBuffer  = fs.readFileSync(filePath);
  const boundary    = `----FormBoundary${Date.now()}`;
  const filename    = path.basename(filePath);

  // Construir multipart/form-data manualmente (sin dependencias extra)
  const parts = [];

  // Campo: model
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1`
  );

  // Campo: language (español costarricense)
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nes`
  );

  // Campo: response_format
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson`
  );

  // Campo: file (el audio)
  const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const fileFooter = `\r\n--${boundary}--\r\n`;

  const bodyParts  = parts.map(p => Buffer.from(p + "\r\n"));
  const headerBuf  = Buffer.from(fileHeader);
  const footerBuf  = Buffer.from(fileFooter);

  const body = Buffer.concat([
    ...bodyParts,
    headerBuf,
    fileBuffer,
    footerBuf,
  ]);

  const result = await httpPost(
    "https://api.openai.com/v1/audio/transcriptions",
    body,
    {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": body.length,
    }
  );

  const json = JSON.parse(result);
  if (!json.text) throw new Error(`Whisper no retornó texto: ${result}`);

  console.log(`🎙️ Transcripción Whisper: "${json.text.slice(0, 100)}..."`);
  return json.text.trim();
}

// ── Función principal: procesar audio entrante ────────────────────────────────
/**
 * Descarga y transcribe un audio de WhatsApp.
 * Retorna el texto o null si falla.
 *
 * @param {string} mediaId - ID del audio en WhatsApp
 * @returns {Promise<string|null>} texto transcrito, o null si falla
 */
async function procesarAudio(mediaId) {
  let tmpFile = null;
  try {
    console.log(`🎙️ Procesando audio: ${mediaId}`);
    const { filePath, mimeType } = await downloadAudio(mediaId);
    tmpFile = filePath;
    const texto = await transcribeAudio(filePath, mimeType);
    return texto;
  } catch (err) {
    console.error(`❌ Error procesando audio ${mediaId}:`, err.message);
    return null;
  } finally {
    // Limpiar archivo temporal
    if (tmpFile) {
      try { fs.unlinkSync(tmpFile); } catch { /* ignorar */ }
    }
  }
}

// ── Helpers HTTP ──────────────────────────────────────────────────────────────

function httpGetJSON(url, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        "Authorization": `Bearer ${token}`,
        "User-Agent": "SSR-Bot/1.0",
      },
    };
    https.get(url, opts, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
      });
    }).on("error", reject);
  });
}

function downloadFile(url, destPath, token) {
  return new Promise((resolve, reject) => {
    const lib  = url.startsWith("https") ? https : http;
    const opts = { headers: { "Authorization": `Bearer ${token}` } };
    lib.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(downloadFile(res.headers.location, destPath, token));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} descargando audio`));
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
      file.on("error", reject);
    }).on("error", reject);
  });
}

function httpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const opts = {
      hostname: parsedUrl.hostname,
      path:     parsedUrl.pathname,
      method:   "POST",
      headers,
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

module.exports = { procesarAudio };
