/**
 * ============================================================
 * metaMensajeria.js — Sasha en Instagram Direct y Facebook Messenger
 * SS Remodelaciones — Sasha Bot
 * ============================================================
 *
 * OBJETIVO (24 sept 2026): que Sasha atienda automáticamente a los
 * clientes que escriben por Instagram o Messenger, igual que en WhatsApp.
 *
 * CÓMO SE IDENTIFICA A CADA CLIENTE
 *   Instagram → "ig_<IGSID>"   Messenger → "fb_<PSID>"
 * Es la misma convención que ya usa el CRM/ERP (filtros Instagram y
 * Facebook del Chat Sasha), así que las conversaciones aparecen solas.
 *
 * FLUJO
 *   server.js /webhook recibe body.object = "instagram" | "page"
 *   → parsearWebhook() devuelve eventos normalizados
 *   → mensajes del cliente: van al mismo buffer/handleMessage que WhatsApp
 *   → ecos (mensajes que salen de la página): si NO los mandó Sasha, es
 *     alguien del equipo respondiendo desde la bandeja de Meta Business
 *     Suite → se pausa a Sasha 60 min con ese cliente (igual que "Tomar
 *     control" en el ERP).
 *   index.js envía con canales.js, que manda por acá todo lo dirigido a
 *   "ig_..." / "fb_...".
 *
 * VARIABLES (Railway):
 *   FB_PAGE_ACCESS_TOKEN  token de la página con pages_messaging e
 *                         instagram_manage_messages (ya existe)
 *   FB_PAGE_ID            id de la página de Facebook (ya existe)
 *   META_APP_ID           opcional, por defecto 968748802318363 (SSREMODELACIONES)
 *
 * LÍMITES DE META
 *   - Texto: 1000 caracteres por mensaje en Instagram, 2000 en Messenger
 *     (se parte automáticamente).
 *   - No hay negrita con *asteriscos*: se limpia el formato de WhatsApp.
 *   - Solo se puede responder dentro de las 24 h siguientes al último
 *     mensaje del cliente (Sasha siempre responde a un mensaje entrante,
 *     así que no aplica a las respuestas automáticas).
 * ============================================================
 */

const API_VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";
const META_APP_ID = String(process.env.META_APP_ID || "968748802318363");

const MAX_IG = 1000;
const MAX_FB = 2000;

// ── Identificadores ─────────────────────────────────────────────────────────

function limpiarPrefijoMas(v) {
  return String(v || "").trim().replace(/^\+/, "");
}

function esDestinoMeta(destino) {
  return /^(ig|fb)_/i.test(limpiarPrefijoMas(destino));
}

function canalDe(destino) {
  const d = limpiarPrefijoMas(destino).toLowerCase();
  if (d.startsWith("ig_")) return "instagram";
  if (d.startsWith("fb_")) return "facebook";
  return "whatsapp";
}

function idReal(destino) {
  return limpiarPrefijoMas(destino).replace(/^(ig|fb)_/i, "");
}

// ── Formato ─────────────────────────────────────────────────────────────────

// Instagram y Messenger no interpretan *negrita* ni _cursiva_ de WhatsApp.
function limpiarFormato(texto) {
  return String(texto || "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/~([^~\n]+)~/g, "$1");
}

// Parte un texto largo respetando párrafos y líneas.
function trocear(texto, max) {
  const t = String(texto || "").trim();
  if (t.length <= max) return t ? [t] : [];

  const partes = [];
  let actual = "";

  const agregar = (bloque, sep) => {
    if (!bloque) return;
    if ((actual ? actual.length + sep.length : 0) + bloque.length <= max) {
      actual = actual ? actual + sep + bloque : bloque;
      return;
    }
    if (actual) partes.push(actual);
    if (bloque.length <= max) {
      actual = bloque;
      return;
    }
    // Bloque más largo que el máximo: corte duro por palabras.
    let resto = bloque;
    while (resto.length > max) {
      let corte = resto.lastIndexOf(" ", max);
      if (corte < max * 0.5) corte = max;
      partes.push(resto.slice(0, corte).trim());
      resto = resto.slice(corte).trim();
    }
    actual = resto;
  };

  t.split(/\n\n+/).forEach((parrafo) => {
    if (parrafo.length <= max) agregar(parrafo, "\n\n");
    else parrafo.split("\n").forEach((linea) => agregar(linea, "\n"));
  });

  if (actual) partes.push(actual);
  return partes;
}

// ── Envío ───────────────────────────────────────────────────────────────────

// IDs de mensajes que mandó Sasha (para distinguir sus ecos de los de un humano).
const midsPropios = new Map(); // mid → timestamp

function registrarMidPropio(mid) {
  if (!mid) return;
  const ahora = Date.now();
  midsPropios.set(mid, ahora);
  for (const [k, ts] of midsPropios) if (ahora - ts > 6 * 3600000) midsPropios.delete(k);
}

async function llamarSendAPI(destino, message) {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error("Falta FB_PAGE_ACCESS_TOKEN en Railway.");

  const r = await fetch(`https://graph.facebook.com/${API_VERSION}/me/messages?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: idReal(destino) },
      messaging_type: "RESPONSE",
      message,
    }),
  });

  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    const e = data?.error || {};
    const err = new Error(`Meta ${canalDe(destino)} [${e.code || r.status}${e.error_subcode ? "/" + e.error_subcode : ""}] ${e.message || "error desconocido"}`);
    err.code = e.code;
    err.subcode = e.error_subcode;
    throw err;
  }

  registrarMidPropio(data.message_id);
  return data;
}

async function enviarTexto(destino, texto) {
  const max = canalDe(destino) === "instagram" ? MAX_IG : MAX_FB;
  const partes = trocear(limpiarFormato(texto), max);
  let ultimo = null;
  for (const parte of partes) {
    ultimo = await llamarSendAPI(destino, { text: parte });
  }
  return ultimo;
}

// Los botones de Instagram/Messenger admiten 20 caracteres: se abrevian
// meses y conectores antes de cortar ("Lunes 28 de septiembre" → "Lunes 28 sept").
const MESES_CORTOS = {
  enero: "ene", febrero: "feb", marzo: "mar", abril: "abr", mayo: "may", junio: "jun",
  julio: "jul", agosto: "ago", septiembre: "sept", setiembre: "set", octubre: "oct",
  noviembre: "nov", diciembre: "dic",
};

function abreviarTitulo(titulo) {
  let t = String(titulo || "").trim();
  if (t.length <= 20) return t;
  t = t.replace(/\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/gi,
    (m) => MESES_CORTOS[m.toLowerCase()] || m);
  t = t.replace(/\s+de\s+/gi, " ").replace(/\s+\d{4}\b/, "").replace(/\s+/g, " ").trim();
  return t.length <= 20 ? t : t.slice(0, 19) + "…";
}

// Opciones rápidas (quick replies). Al tocarlas, llega su payload como
// texto del cliente — igual que el id de una lista/botón de WhatsApp.
async function enviarOpciones(destino, texto, opciones) {
  const quick = (opciones || [])
    .filter((o) => o && o.id && o.title)
    .slice(0, 13)
    .map((o) => ({
      content_type: "text",
      title: abreviarTitulo(o.title),
      payload: String(o.id).slice(0, 1000),
    }));

  const max = canalDe(destino) === "instagram" ? MAX_IG : MAX_FB;
  const partes = trocear(limpiarFormato(texto), max);
  if (!partes.length) partes.push("Elija una opción:");

  // El texto largo va primero; las opciones van pegadas al último pedazo.
  for (let i = 0; i < partes.length - 1; i++) {
    await llamarSendAPI(destino, { text: partes[i] });
  }

  const message = { text: partes[partes.length - 1] };
  if (quick.length) message.quick_replies = quick;
  return llamarSendAPI(destino, message);
}

// Adaptador de la lista de WhatsApp (sections → rows) a opciones rápidas.
async function enviarLista(destino, texto, secciones) {
  const opciones = [];
  (secciones || []).forEach((s) => (s.rows || []).forEach((row) => opciones.push({ id: row.id, title: row.title })));
  return enviarOpciones(destino, texto, opciones);
}

// Adaptador de botones de WhatsApp ([{ id, title }]) a opciones rápidas.
async function enviarBotones(destino, texto, botones) {
  return enviarOpciones(destino, texto, botones);
}

// ── Recepción ───────────────────────────────────────────────────────────────

const midsProcesados = new Map(); // anti-reintentos de Meta

function yaProcesado(mid) {
  if (!mid) return false;
  const ahora = Date.now();
  for (const [k, ts] of midsProcesados) if (ahora - ts > 6 * 3600000) midsProcesados.delete(k);
  if (midsProcesados.has(mid)) return true;
  midsProcesados.set(mid, ahora);
  return false;
}

function describirAdjuntos(adjuntos) {
  const tipos = (adjuntos || []).map((a) => a && a.type).filter(Boolean);
  if (!tipos.length) return "";
  if (tipos.includes("image")) return "[El cliente envió una imagen]";
  if (tipos.includes("video")) return "[El cliente envió un video]";
  if (tipos.includes("audio")) return "[El cliente envió un mensaje de voz]";
  if (tipos.includes("file")) return "[El cliente envió un archivo]";
  if (tipos.includes("share") || tipos.includes("ig_reel") || tipos.includes("reel")) return "[El cliente compartió una publicación]";
  if (tipos.includes("story_mention")) return "[El cliente mencionó a SSR en una historia]";
  return "[El cliente envió un adjunto]";
}

/**
 * Convierte el body del webhook en una lista de eventos:
 *   { tipo: "mensaje", canal, from, texto, mid }
 *   { tipo: "eco",     canal, cliente, texto, mid, appId }
 * Ignora lecturas, reacciones, ediciones y entregas.
 */
function parsearWebhook(body) {
  const objeto = body && body.object;
  if (objeto !== "instagram" && objeto !== "page") return [];

  const canal = objeto === "instagram" ? "instagram" : "facebook";
  const prefijo = canal === "instagram" ? "ig_" : "fb_";
  const eventos = [];

  (body.entry || []).forEach((entry) => {
    (entry.messaging || []).forEach((ev) => {
      const senderId = ev.sender && ev.sender.id;
      const recipientId = ev.recipient && ev.recipient.id;

      // Botón "Empezar" / postback de Messenger
      if (ev.postback && senderId) {
        eventos.push({
          tipo: "mensaje",
          canal,
          from: prefijo + senderId,
          texto: String(ev.postback.payload || ev.postback.title || "Hola"),
          mid: ev.postback.mid || `pb_${senderId}_${ev.timestamp}`,
        });
        return;
      }

      const msg = ev.message;
      if (!msg || msg.is_deleted || msg.is_unsupported) return;

      if (msg.is_echo) {
        eventos.push({
          tipo: "eco",
          canal,
          cliente: prefijo + recipientId,
          texto: msg.text || describirAdjuntos(msg.attachments) || "",
          mid: msg.mid,
          appId: msg.app_id ? String(msg.app_id) : "",
        });
        return;
      }

      if (!senderId) return;

      const texto =
        (msg.quick_reply && msg.quick_reply.payload) ||
        msg.text ||
        describirAdjuntos(msg.attachments);

      if (!texto) return;

      eventos.push({ tipo: "mensaje", canal, from: prefijo + senderId, texto: String(texto), mid: msg.mid });
    });
  });

  return eventos;
}

/**
 * Decide si un eco lo mandó Sasha o una persona desde la bandeja de Meta.
 * Se espera unos segundos porque el eco puede llegar antes de que la API
 * nos devuelva el message_id del envío.
 * Devuelve Promise<boolean> (true = lo mandó un humano).
 */
function esEcoHumano(eco) {
  return new Promise((resolve) => {
    setTimeout(() => {
      if (eco.appId && eco.appId === META_APP_ID) return resolve(false);
      if (eco.mid && midsPropios.has(eco.mid)) return resolve(false);
      resolve(true);
    }, 5000);
  });
}

// ── Diagnóstico / configuración ─────────────────────────────────────────────

async function graphGET(ruta, token) {
  const sep = ruta.includes("?") ? "&" : "?";
  const r = await fetch(`https://graph.facebook.com/${API_VERSION}/${ruta}${sep}access_token=${encodeURIComponent(token)}`);
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, data };
}

async function diagnostico() {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  const pageId = process.env.FB_PAGE_ID;
  const out = { FB_PAGE_ACCESS_TOKEN: !!token, FB_PAGE_ID: pageId || null };
  if (!token) return out;

  const yo = await graphGET("me?fields=id,name", token);
  out.pagina = yo.ok ? yo.data : { error: yo.data?.error?.message };

  const idPagina = (yo.ok && yo.data.id) || pageId;
  if (idPagina) {
    const ig = await graphGET(`${idPagina}?fields=instagram_business_account{id,username}`, token);
    out.instagram = ig.ok ? (ig.data.instagram_business_account || "NO VINCULADO a la página") : { error: ig.data?.error?.message };

    const subs = await graphGET(`${idPagina}/subscribed_apps`, token);
    out.appsSuscritas = subs.ok ? subs.data.data : { error: subs.data?.error?.message };
  }

  const dbg = await graphGET(`debug_token?input_token=${encodeURIComponent(token)}`, token);
  if (dbg.ok && dbg.data && dbg.data.data) {
    out.token = {
      tipo: dbg.data.data.type,
      valido: dbg.data.data.is_valid,
      expira: dbg.data.data.expires_at ? new Date(dbg.data.data.expires_at * 1000).toISOString() : "no expira",
      permisos: dbg.data.data.scopes,
    };
    const scopes = dbg.data.data.scopes || [];
    out.faltanPermisos = ["pages_messaging", "instagram_manage_messages", "pages_manage_metadata", "instagram_basic"]
      .filter((p) => !scopes.includes(p));
  }

  return out;
}

// Suscribe la página a los eventos de mensajería de esta app.
async function suscribirPagina() {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error("Falta FB_PAGE_ACCESS_TOKEN en Railway.");
  const yo = await graphGET("me?fields=id", token);
  const idPagina = (yo.ok && yo.data.id) || process.env.FB_PAGE_ID;
  if (!idPagina) throw new Error("No se pudo determinar el id de la página.");

  const campos = "messages,messaging_postbacks,message_echoes,messaging_optins";
  const r = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${idPagina}/subscribed_apps?subscribed_fields=${campos}&access_token=${encodeURIComponent(token)}`,
    { method: "POST" }
  );
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
  return { pagina: idPagina, campos, resultado: data };
}

module.exports = {
  esDestinoMeta,
  canalDe,
  idReal,
  limpiarFormato,
  enviarTexto,
  enviarOpciones,
  enviarLista,
  enviarBotones,
  parsearWebhook,
  yaProcesado,
  esEcoHumano,
  diagnostico,
  suscribirPagina,
};
