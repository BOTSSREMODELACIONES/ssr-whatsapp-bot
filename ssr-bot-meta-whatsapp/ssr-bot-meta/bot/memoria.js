/**
 * memoria.js — Sistema de Memoria Persistente para Sasha
 * SSR Remodelaciones
 *
 * Guarda TODOS los mensajes en Google Sheets y los medias en Drive.
 * Permite a Darwin preguntar por historial de cualquier cliente.
 *
 * Datos almacenados:
 *  - MENSAJES: cada mensaje (entrada/salida), con fecha, cliente, contenido y media
 *  - CLIENTES: resumen por cliente (nombre, proyecto, zona, última actividad)
 *
 * Uso desde Darwin (enviar a Sasha):
 *  - "historial +50688887777"
 *  - "qué habló María González"
 *  - "fotos de Juan Pérez"
 *  - "listar clientes"
 *  - "buscar remodelación cocina"
 */

const { google } = require("googleapis");
const { Readable } = require("stream");

// ── Constantes ────────────────────────────────────────────────────────────────
const DARWIN_EMAIL   = "proyectos@ssremodelaciones.com";
const SHEET_TITLE    = "SSR_Memoria_Chats";
const TZ             = "America/Costa_Rica";

// Carpeta raíz para fotos de clientes en Drive (configurable vía env)
const MEDIA_PARENT_ID = process.env.MEDIA_FOLDER_ID || null;

// Cache de IDs para evitar llamadas repetidas a la API
let _sheetId     = process.env.MEMORY_SHEET_ID || null;
const _folderCache = {};

// ── Auth ──────────────────────────────────────────────────────────────────────
// FIX: Se eliminó "subject: DARWIN_EMAIL" que causaba error unauthorized_client.
// El service account ahora se autentica como sí mismo (no intenta impersonar).
// El sheet SSR_Memoria_Chats debe estar compartido con el email del service account.
async function getAuth() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  return new google.auth.JWT({
    email:   creds.client_email,
    key:     creds.private_key,
    scopes:  [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive",
    ],
  });
}

async function getSheetsClient() {
  return google.sheets({ version: "v4", auth: await getAuth() });
}

async function getDriveClient() {
  return google.drive({ version: "v3", auth: await getAuth() });
}

// ── Obtener o crear el Google Sheet de memoria ────────────────────────────────
async function getOrCreateSheetId() {
  if (_sheetId) return _sheetId;

  const drive  = await getDriveClient();
  const sheets = await getSheetsClient();

  // 1. Buscar si ya existe
  const search = await drive.files.list({
    q: `name='${SHEET_TITLE}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    fields: "files(id,name)",
    spaces: "drive",
  });

  if (search.data.files.length > 0) {
    _sheetId = search.data.files[0].id;
    console.log(`✅ Memoria: sheet encontrado (${_sheetId})`);
    return _sheetId;
  }

  // 2. Crear nuevo spreadsheet
  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: SHEET_TITLE },
      sheets: [
        {
          properties: { title: "MENSAJES", index: 0 },
          data: [{
            startRow: 0, startColumn: 0,
            rowData: [{
              values: [
                "TIMESTAMP", "TELÉFONO", "NOMBRE_CLIENTE",
                "DIRECCIÓN", "TIPO", "CONTENIDO",
                "MEDIA_ID", "DRIVE_URL", "PROYECTO", "ZONA",
              ].map(v => ({ userEnteredValue: { stringValue: v }, userEnteredFormat: { textFormat: { bold: true } } })),
            }],
          }],
        },
        {
          properties: { title: "CLIENTES", index: 1 },
          data: [{
            startRow: 0, startColumn: 0,
            rowData: [{
              values: [
                "TELÉFONO", "NOMBRE", "PROYECTO", "ZONA",
                "PRIMERA_ACTIVIDAD", "ÚLTIMA_ACTIVIDAD",
                "TOTAL_MENSAJES", "VISITA_AGENDADA",
              ].map(v => ({ userEnteredValue: { stringValue: v }, userEnteredFormat: { textFormat: { bold: true } } })),
            }],
          }],
        },
      ],
    },
  });

  _sheetId = created.data.spreadsheetId;
  console.log(`✅ Memoria: sheet creado (${_sheetId})`);

  // Compartir con Darwin para que pueda verlo
  try {
    await drive.permissions.create({
      fileId: _sheetId,
      requestBody: { role: "writer", type: "user", emailAddress: DARWIN_EMAIL },
    });
    console.log(`✅ Memoria: sheet compartido con ${DARWIN_EMAIL}`);
  } catch (e) {
    console.warn("⚠️ Memoria: no se pudo compartir el sheet:", e.message);
  }

  return _sheetId;
}

// ── Guardar mensaje en Google Sheets ─────────────────────────────────────────
/**
 * @param {object} params
 * @param {string} params.phone         - número del cliente con +
 * @param {string} [params.clientName]  - nombre del cliente (si se conoce)
 * @param {"in"|"out"} params.direction - "in" = cliente → Sasha | "out" = Sasha → cliente
 * @param {"text"|"image"|"audio"|"document"} params.type
 * @param {string} params.content       - texto del mensaje o descripción
 * @param {string} [params.mediaId]     - WhatsApp media ID
 * @param {string} [params.driveUrl]    - URL del archivo guardado en Drive
 * @param {object} [params.session]     - estado de la sesión actual
 */
async function guardarMensaje({ phone, clientName, direction, type, content, mediaId = "", driveUrl = "", session = null }) {
  try {
    const sheetId = await getOrCreateSheetId();
    const sheets  = await getSheetsClient();

    const timestamp = new Date().toISOString();
    const proyecto  = session?.project_desc || "";
    const zona      = session?.zone || "";
    const nombre    = clientName || session?.name || "";

    // Guardar en MENSAJES
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: "MENSAJES!A:J",
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          timestamp, phone, nombre,
          direction, type, content,
          mediaId, driveUrl, proyecto, zona,
        ]],
      },
    });

    // Actualizar resumen en CLIENTES (no esperar, es secundario)
    actualizarCliente(sheetId, sheets, phone, nombre, proyecto, zona, session?.visit_confirmed || false)
      .catch(e => console.warn("⚠️ Memoria: no se actualizó CLIENTES:", e.message));

  } catch (err) {
    // NO lanzar: la memoria es secundaria al flujo principal
    console.error("❌ Memoria: error guardando mensaje:", err.message);
  }
}

// ── Actualizar resumen de cliente ─────────────────────────────────────────────
async function actualizarCliente(sheetId, sheets, phone, nombre, proyecto, zona, visitaAgendada) {
  const res  = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "CLIENTES!A:H" });
  const rows = res.data.values || [];
  const now  = new Date().toISOString();

  const idx  = rows.findIndex((r, i) => i > 0 && r[0] === phone);

  if (idx === -1) {
    // Cliente nuevo
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: "CLIENTES!A:H",
      valueInputOption: "RAW",
      requestBody: {
        values: [[phone, nombre, proyecto, zona, now, now, "1", visitaAgendada ? "Sí" : "No"]],
      },
    });
  } else {
    // Actualizar existente
    const prev = rows[idx];
    const rowNum = idx + 1;
    const nuevoTotal = (parseInt(prev[6] || "0") + 1).toString();
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `CLIENTES!A${rowNum}:H${rowNum}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          phone,
          nombre    || prev[1] || "",
          proyecto  || prev[2] || "",
          zona      || prev[3] || "",
          prev[4]   || now,           // primera actividad (no cambiar)
          now,                        // última actividad
          nuevoTotal,
          visitaAgendada ? "Sí" : (prev[7] || "No"),
        ]],
      },
    });
  }
}

// ── Guardar media en Drive ────────────────────────────────────────────────────
/**
 * @param {Buffer} buffer
 * @param {string} mimeType  - ej: "image/jpeg"
 * @param {string} phone     - número del cliente
 * @param {string} [name]    - nombre del cliente (para la carpeta)
 * @returns {Promise<string|null>} URL de Drive o null si falla
 */
async function guardarMedia(buffer, mimeType, phone, name) {
  try {
    const drive    = await getDriveClient();
    const folderId = await getOrCreateMediaFolder(drive, phone, name);

    const ext  = (mimeType.split("/")[1] || "jpg").replace("jpeg", "jpg");
    const ts   = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = await drive.files.create({
      requestBody: {
        name:    `${phone}_${ts}.${ext}`,
        parents: [folderId],
      },
      media: {
        mimeType,
        body: Readable.from(buffer),
      },
      fields: "id, webViewLink",
    });

    // Dar acceso de lectura a Darwin
    await drive.permissions.create({
      fileId: file.data.id,
      requestBody: { role: "reader", type: "user", emailAddress: DARWIN_EMAIL },
    }).catch(() => {});

    console.log(`✅ Memoria: foto guardada → ${file.data.webViewLink}`);
    return file.data.webViewLink;

  } catch (err) {
    console.error("❌ Memoria: error guardando media:", err.message);
    return null;
  }
}

// ── Obtener o crear carpeta de media por cliente ──────────────────────────────
async function getOrCreateMediaFolder(drive, phone, clientName) {
  if (_folderCache[phone]) return _folderCache[phone];

  const safeName = (clientName || "").replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ\s]/g, "").trim().slice(0, 25);
  const folderName = `Chats_${phone}${safeName ? `_${safeName}` : ""}`;

  // Buscar carpeta existente
  const q = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const search = await drive.files.list({ q, fields: "files(id)", spaces: "drive" });

  if (search.data.files.length > 0) {
    _folderCache[phone] = search.data.files[0].id;
    return _folderCache[phone];
  }

  // Crear carpeta
  const folder = await drive.files.create({
    requestBody: {
      name:     folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents:  MEDIA_PARENT_ID ? [MEDIA_PARENT_ID] : [],
    },
    fields: "id",
  });

  // Dar acceso a Darwin
  await drive.permissions.create({
    fileId: folder.data.id,
    requestBody: { role: "reader", type: "user", emailAddress: DARWIN_EMAIL },
  }).catch(() => {});

  _folderCache[phone] = folder.data.id;
  console.log(`✅ Memoria: carpeta creada para ${phone}: ${folderName}`);
  return _folderCache[phone];
}

// ── Funciones de búsqueda ─────────────────────────────────────────────────────

/** Obtener todos los mensajes de un número de teléfono */
async function buscarPorTelefono(phone, limit = 60) {
  const sheetId = await getOrCreateSheetId();
  const sheets  = await getSheetsClient();
  const res     = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "MENSAJES!A:J" });
  const rows    = (res.data.values || []).slice(1);
  const clean   = phone.replace(/\D/g, "");
  return rows.filter(r => (r[1] || "").replace(/\D/g, "").endsWith(clean)).slice(-limit);
}

/** Obtener mensajes de un cliente por nombre (búsqueda parcial) */
async function buscarPorNombre(nombre, limit = 60) {
  const sheetId = await getOrCreateSheetId();
  const sheets  = await getSheetsClient();
  const res     = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "MENSAJES!A:J" });
  const rows    = (res.data.values || []).slice(1);
  const kw      = normalizar(nombre);
  return rows.filter(r => normalizar(r[2] || "").includes(kw) || normalizar(r[8] || "").includes(kw)).slice(-limit);
}

/** Buscar en el contenido de los mensajes (keyword) */
async function buscarPorContenido(keyword, limit = 30) {
  const sheetId = await getOrCreateSheetId();
  const sheets  = await getSheetsClient();
  const res     = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "MENSAJES!A:J" });
  const rows    = (res.data.values || []).slice(1);
  const kw      = normalizar(keyword);
  return rows.filter(r => normalizar(r[5] || "").includes(kw)).slice(-limit);
}

/** Listar todos los clientes con resumen */
async function listarClientes() {
  const sheetId = await getOrCreateSheetId();
  const sheets  = await getSheetsClient();
  const res     = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "CLIENTES!A:H" });
  return (res.data.values || []).slice(1);
}

/** Obtener solo filas de imágenes (con driveUrl) de un cliente */
async function obtenerFotos(query) {
  const clean = query.replace(/\D/g, "");
  let rows;
  if (clean.length >= 8) {
    rows = await buscarPorTelefono(query, 200);
  } else {
    rows = await buscarPorNombre(query, 200);
  }
  return rows.filter(r => r[4] === "image" && r[7]);
}

// ── Formatear historial para enviar a Darwin ──────────────────────────────────
function formatearMensajes(rows, titulo = "Historial") {
  if (!rows || rows.length === 0) return null;

  // Agrupar por fecha
  const groups = {};
  for (const r of rows) {
    const fecha = new Date(r[0]).toLocaleDateString("es-CR", { timeZone: TZ, dateStyle: "full" });
    if (!groups[fecha]) groups[fecha] = [];
    groups[fecha].push(r);
  }

  const lines = [`📋 *${titulo}* (${rows.length} mensajes)\n`];

  for (const [fecha, msgs] of Object.entries(groups)) {
    lines.push(`\n📅 *${fecha}*`);
    for (const r of msgs) {
      const hora      = new Date(r[0]).toLocaleTimeString("es-CR", { timeZone: TZ, timeStyle: "short" });
      const quien     = r[3] === "in" ? "🧑 *Cliente*" : "🤖 *Sasha*";
      const isMedia   = r[4] === "image";
      const contenido = isMedia
        ? `[📷 Foto${r[7] ? `: ${r[7]}` : ""}]`
        : (r[5] || "").slice(0, 200);
      lines.push(`${hora} ${quien}: ${contenido}`);
    }
  }

  return lines.join("\n");
}

// ── Detectar si un mensaje de Darwin es una consulta de memoria ───────────────
const MEMORY_TRIGGERS = [
  /historial/i,
  /qu[eé]\s+(hab[ló]|dij[oi]|mand[oó]|escrib)/i,
  /conversaci[oó]n/i,
  /fotos?\s+de/i,
  /listar?\s+clientes?/i,
  /buscar?\s+/i,
  /cu[aá]ntos?\s+mensajes?/i,
  /[+]506[\s\d]{8,}/,
  /mem[oó]ria/i,
  /cliente[s]?\s+activos?/i,
];

function esConsultaMemoria(text) {
  return MEMORY_TRIGGERS.some(re => re.test(text));
}

// ── Procesar consulta de memoria de Darwin ────────────────────────────────────
/**
 * @returns {string|null} respuesta lista para enviar, o null si no es consulta de memoria
 */
async function procesarConsultaMemoria(text) {
  if (!esConsultaMemoria(text)) return null;

  const normalText = normalizar(text);

  try {
    // ── Listar clientes ──────────────────────────────────────────────────────
    if (/listar?.*(clientes?|activos?)/.test(normalText)) {
      const clientes = await listarClientes();
      if (!clientes.length) return "📭 No hay clientes registrados en memoria aún.";

      const lines = clientes.slice(-30).map(r => {
        const nombre = r[1] || r[0];
        const ult    = r[5] ? new Date(r[5]).toLocaleDateString("es-CR", { timeZone: TZ }) : "—";
        const visita = r[7] === "Sí" ? " ✅" : "";
        return `📱 ${r[0]} — ${nombre}${visita} (últ: ${ult})`;
      });

      return `👥 *Clientes registrados (${clientes.length}):*\n\n${lines.join("\n")}`;
    }

    // ── Fotos de cliente ─────────────────────────────────────────────────────
    const fotosMatch = text.match(/fotos?\s+de\s+(.+)/i);
    if (fotosMatch) {
      const query = fotosMatch[1].replace(/[?.!].*$/, "").trim();
      const fotos = await obtenerFotos(query);
      if (!fotos.length) return `📭 No encontré fotos de "${query}".`;
      const lines = fotos.slice(-20).map(r => {
        const hora = new Date(r[0]).toLocaleString("es-CR", { timeZone: TZ });
        return `📷 ${hora}: ${r[7]}`;
      });
      return `📷 *Fotos de ${query}* (${fotos.length}):\n\n${lines.join("\n")}`;
    }

    // ── Buscar por contenido ─────────────────────────────────────────────────
    const buscarMatch = text.match(/buscar?\s+(.+)/i);
    if (buscarMatch) {
      const keyword = buscarMatch[1].replace(/[?.!].*$/, "").trim();
      const rows = await buscarPorContenido(keyword);
      if (!rows.length) return `📭 No encontré mensajes con "${keyword}".`;
      const hist = formatearMensajes(rows, `Resultados: "${keyword}"`);
      return hist || `📭 Sin resultados para "${keyword}".`;
    }

    // ── Historial por teléfono ───────────────────────────────────────────────
    const phoneMatch = text.match(/[+]?506\s*(\d{4}[\s-]?\d{4})/);
    if (phoneMatch) {
      const phone = "506" + phoneMatch[1].replace(/\D/g, "");
      const rows = await buscarPorTelefono(phone);
      if (!rows.length) return `📭 No encontré conversaciones de +${phone}.`;
      const clientName = rows[0][2] || phone;
      const hist = formatearMensajes(rows, `Historial de ${clientName} (+${phone})`);
      return hist || `📭 Sin mensajes de +${phone}.`;
    }

    // ── Historial por nombre ─────────────────────────────────────────────────
    const nombrePatterns = [
      /historial\s+(?:de\s+)?(.+)/i,
      /qu[eé]\s+(?:hab[ló]|dij[oi]|mand[oó])\s+(.+)/i,
      /conversaci[oó]n\s+(?:de\s+)?(.+)/i,
      /cu[aá]ntos?\s+mensajes?\s+(?:de\s+|tiene\s+)?(.+)/i,
    ];

    for (const pattern of nombrePatterns) {
      const match = text.match(pattern);
      if (match) {
        const nombre = match[1].replace(/[?.!].*$/, "").trim();
        if (nombre.length < 3) continue;

        const rows = await buscarPorNombre(nombre);
        if (!rows.length) return `📭 No encontré conversaciones de "${nombre}".`;

        const phone      = rows[0][1];
        const clientName = rows[0][2] || nombre;
        const hist       = formatearMensajes(rows, `Historial de ${clientName} (${phone})`);
        return hist || `📭 Sin mensajes de "${nombre}".`;
      }
    }

    // ── Fallback: decirle qué puede buscar ───────────────────────────────────
    return [
      "🧠 *Comandos de memoria disponibles:*",
      "",
      "• `historial [nombre o número]` — ver conversación completa",
      "• `fotos de [nombre]` — links de fotos enviadas",
      "• `buscar [palabra]` — buscar en el contenido",
      "• `listar clientes` — todos los clientes",
      "",
      "_Ejemplos:_",
      "  historial María González",
      "  historial +50688887777",
      "  fotos de Juan Pérez",
      "  buscar remodelación cocina",
    ].join("\n");

  } catch (err) {
    console.error("❌ Memoria: error procesando consulta:", err.message);
    return `❌ Error al buscar en memoria: ${err.message}`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function normalizar(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

module.exports = {
  guardarMensaje,
  guardarMedia,
  buscarPorTelefono,
  buscarPorNombre,
  buscarPorContenido,
  listarClientes,
  obtenerFotos,
  formatearMensajes,
  esConsultaMemoria,
  procesarConsultaMemoria,
};
