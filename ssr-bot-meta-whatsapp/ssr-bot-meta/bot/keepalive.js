/**
 * keepalive.js — Self-ping para mantener Sasha activa en Railway
 * SS Remodelaciones
 *
 * Railway puede suspender procesos por inactividad en planes Hobby/Developer.
 * Este módulo hace un ping a la propia URL del servicio cada 14 minutos,
 * evitando el timeout de inactividad (Railway usa ~15 min como umbral).
 *
 * USO: require("./keepalive") en server.js — una sola línea.
 * No necesita configuración si BOT_URL está en las variables de Railway.
 *
 * Variables de entorno (agregar en Railway → Variables):
 *   BOT_URL → https://ssr-whatsapp-bot-production.up.railway.app
 *             (la URL pública de tu servicio en Railway)
 */

const PING_INTERVAL_MS = 14 * 60 * 1000; // 14 minutos
const PING_ENDPOINT    = "/health";

function getBaseUrl() {
  // Railway inyecta RAILWAY_PUBLIC_DOMAIN automáticamente en algunos planes.
  // Si no, usamos BOT_URL que vos configurás.
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.BOT_URL || null;
  if (!domain) return null;

  // Normalizar: asegurar https:// al inicio y sin trailing slash
  let url = domain.trim().replace(/\/+$/, "");
  if (!url.startsWith("http")) url = `https://${url}`;
  return url;
}

function iniciarKeepAlive() {
  const baseUrl = getBaseUrl();

  if (!baseUrl) {
    console.warn("⚠️ KeepAlive: BOT_URL no configurada. Sasha puede dormir si Railway la suspende.");
    console.warn("   → Agrega BOT_URL=https://ssr-whatsapp-bot-production.up.railway.app en Railway → Variables");
    return;
  }

  const pingUrl = `${baseUrl}${PING_ENDPOINT}`;
  console.log(`💓 KeepAlive: activo — ping cada 14 min a ${pingUrl}`);

  // Ping inmediato al arrancar (para loggear que funciona)
  setTimeout(() => ping(pingUrl), 5000);

  // Ping periódico
  setInterval(() => ping(pingUrl), PING_INTERVAL_MS);
}

async function ping(url) {
  try {
    const res = await fetch(url, {
      method:  "GET",
      headers: { "User-Agent": "Sasha-KeepAlive/1.0" },
      signal:  AbortSignal.timeout(10000), // timeout 10 seg
    });
    if (res.ok) {
      console.log(`💓 KeepAlive: ping OK (${res.status}) — ${new Date().toLocaleString("es-CR", { timeZone: "America/Costa_Rica" })}`);
    } else {
      console.warn(`⚠️ KeepAlive: ping respondió ${res.status}`);
    }
  } catch (err) {
    console.warn(`⚠️ KeepAlive: ping falló — ${err.message}`);
  }
}

iniciarKeepAlive();

module.exports = { iniciarKeepAlive };
