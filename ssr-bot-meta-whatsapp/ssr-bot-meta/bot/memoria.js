/**
 * memoria.js — Sistema de Memoria Persistente para Sasha
 * SSR Remodelaciones
 *
 * Guarda TODOS los mensajes en Google Sheets y los medias en Drive.
 * Permite a Darwin preguntar por historial de cualquier cliente.
 *
 * FUENTES DE DATOS:
 *  - SSR_Memoria_Chats  → historial de conversaciones de WhatsApp
 *  - CRM_Sasha_SSR      → lista de clientes, proyectos, visitas (fuente principal)
 *
 * Comandos disponibles:
 *  - "listar clientes"           → lista del CRM
 *  - "historial [nombre/número]" → conversaciones de WhatsApp
 *  - "qué habló [nombre]"        → conversaciones de WhatsApp
 *  - "fotos de [nombre]"         → fotos enviadas por el cliente
 *  - "buscar [palabra]"          → buscar en conversaciones
 *  - "info [nombre/número]"      → ficha completa del cliente desde CRM
 */

const { google } = require("googleapis");
const { Readable } = require("stream");

// ── Constantes ────────────────────────────────────────────────────────────────
const DARWIN_EMAIL   = "proyectos@ssremodelaciones.com";
const SHEET_TITLE    = "SSR_Memoria_Chats";
const TZ             = "America/Costa_Rica";

// ID del CRM principal (ya existe y tiene todos los clientes)
const CRM_SHEET_ID   = "1LOUDwOe8W5pAF0QV0lTqC9uCcQ0fc_JaIMcGu2f5aZ4";

const MEDIA_PARENT_ID = process.env.MEDIA_FOLDER_ID || null;

let _sheetId     = process.env.MEMORY_SHEET_ID || null;
const _folderCache = {};

// ── Auth ──────────────────────────────────────────────────────────────────────
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

// ── Obtener o crear el Google Sheet de memoria (conversaciones) ───────────────
async function getOrCreateSheetId() {
  if (_sheetId) return _sheetId;

  const drive  = await getDriveClient();
  const sheets = await getSheetsClient();

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
async function guardarMensaje({ phone, clientName, direction, type, content, mediaId = "", driveUrl = "", session = null }) {
  try {
    const sheetId = await getOrCreateSheetId();
    const sheets  = await getSheetsClient();

    const timestamp = new Date().toISOString();
    const proyecto  = session?.project_desc || "";
    const zona      = session?.zone || "";
    const nombre    = clientName || session?.name || "";

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: "MENSAJES!A:J",
      valueInputOption: "RAW",
      requestBody: {
        values: [[timestamp, phone, nombre, direction, type, content, mediaId, driveUrl, proyecto, zona]],
      },
    });

    actualizarCliente(sheetId, sheets, phone, nombre, proyecto, zona, session?.visit_confirmed || false)
      .catch(e => console.warn("⚠️ Memoria: no se actualizó CLIENTES:", e.message));

  } catch (err) {
    console.error("❌ Memoria: error guardando mensaje:", err.message);
  }
}

// ── Actualizar resumen de cliente en SSR_Memoria_Chats ────────────────────────
async function actualizarCliente(sheetId, sheets, phone, nombre, proyecto, zona, visitaAgendada) {
  const res  = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "CLIENTES!A:H" });
  const rows = res.data.values || [];
  const now  = new Date().toISOString();
  const idx  = rows.findIndex((r, i) => i > 0 && r[0] === phone);

  if (idx === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: "CLIENTES!A:H",
      valueInputOption: "RAW",
      requestBody: { values: [[phone, nombre, proyecto, zona, now, now, "1", visitaAgendada ? "Sí" : "No"]] },
    });
  } else {
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
          prev[4]   || now,
          now,
          nuevoTotal,
          visitaAgendada ? "Sí" : (prev[7] || "No"),
        ]],
      },
    });
  }
}

// ── Leer clientes del CRM principal ──────────────────────────────────────────
/**
 * Lee la hoja "CRM Clientes" del CRM principal (CRM_Sasha_SSR).
 * Esta es la fuente de verdad de todos los clientes.
 */
async function listarClientesCRM(limit = 30) {
  try {
    const sheets = await getSheetsClient();
    const res    = await sheets.spreadsheets.values.get({
      spreadsheetId: CRM_SHEET_ID,
      range: "'CRM Clientes'!A:S",
    });
    const rows = (res.data.values || []).slice(2); // saltar encabezados (fila 1 y 2)
    return rows.filter(r => r[1] && r[1].toString().trim() !== "").slice(-limit);
  } catch (err) {
    console.error("❌ Memoria: error leyendo CRM:", err.message);
    return [];
  }
}

/**
 * Buscar un cliente específico en el CRM por nombre o teléfono.
 */
async function buscarClienteEnCRM(query) {
  try {
    const sheets = await getSheetsClient();
    const res    = await sheets.spreadsheets.values.get({
      spreadsheetId: CRM_SHEET_ID,
      range: "'CRM Clientes'!A:S",
    });
    const rows = (res.data.values || []).slice(2);
    const kw   = normalizar(query);
    const soloDigitos = query.replace(/\D/g, "");

    return rows.filter(r => {
      const nombre  = normalizar(r[2] || "");
      const telefono = (r[1] || "").replace(/\D/g, "");
      return nombre.includes(kw) || (soloDigitos.length >= 6 && telefono.endsWith(soloDigitos));
    });
  } catch (err) {
    console.error("❌ Memoria: error buscando en CRM:", err.message);
    return [];
  }
}

// ── Guardar media en Drive ────────────────────────────────────────────────────
async function guardarMedia(buffer, mimeType, phone, name) {
  try {
    const drive    = await getDriveClient();
    const folderId = await getOrCreateMediaFolder(drive, phone, name);

    const ext  = (mimeType.split("/")[1] || "jpg").replace("jpeg", "jpg");
    const ts   = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = await drive.files.create({
      requestBody: { name: `${phone}_${ts}.${ext}`, parents: [folderId] },
      media: { mimeType, body: Readable.from(buffer) },
      fields: "id, webViewLink",
    });

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

  const safeName   = (clientName || "").replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ\s]/g, "").trim().slice(0, 25);
  const folderName = `Chats_${phone}${safeName ? `_${safeName}` : ""}`;

  const q      = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const search = await drive.files.list({ q, fields: "files(id)", spaces: "drive" });

  if (search.data.files.length > 0) {
    _folderCache[phone] = search.data.files[0].id;
    return _folderCache[phone];
  }

  const folder = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: MEDIA_PARENT_ID ? [MEDIA_PARENT_ID] : [],
    },
    fields: "id",
  });

  await drive.permissions.create({
    fileId: folder.data.id,
    requestBody: { role: "reader", type: "user", emailAddress: DARWIN_EMAIL },
  }).catch(() => {});

  _folderCache[phone] = folder.data.id;
  return _folderCache[phone];
}

// ── Funciones de búsqueda en conversaciones ───────────────────────────────────
async function buscarPorTelefono(phone, limit = 60) {
  const sheetId = await getOrCreateSheetId();
  const sheets  = await getSheetsClient();
  const res     = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "MENSAJES!A:J" });
  const rows    = (res.data.values || []).slice(1);
  const clean   = phone.replace(/\D/g, "");
  return rows.filter(r => (r[1] || "").replace(/\D/g, "").endsWith(clean)).slice(-limit);
}

async function buscarPorNombre(nombre, limit = 60) {
  const sheetId = await getOrCreateSheetId();
  const sheets  = await getSheetsClient();
  const res     = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "MENSAJES!A:J" });
  const rows    = (res.data.values || []).slice(1);
  const kw      = normalizar(nombre);
  return rows.filter(r => normalizar(r[2] || "").includes(kw) || normalizar(r[8] || "").includes(kw)).slice(-limit);
}

async function buscarPorContenido(keyword, limit = 30) {
  const sheetId = await getOrCreateSheetId();
  const sheets  = await getSheetsClient();
  const res     = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "MENSAJES!A:J" });
  const rows    = (res.data.values || []).slice(1);
  const kw      = normalizar(keyword);
  return rows.filter(r => normalizar(r[5] || "").includes(kw)).slice(-limit);
}

async function listarClientes() {
  const sheetId = await getOrCreateSheetId();
  const sheets  = await getSheetsClient();
  const res     = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "CLIENTES!A:H" });
  return (res.data.values || []).slice(1);
}

async function obtenerFotos(query) {
  const clean = query.replace(/\D/g, "");
  const rows  = clean.length >= 8 ? await buscarPorTelefono(query, 200) : await buscarPorNombre(query, 200);
  return rows.filter(r => r[4] === "image" && r[7]);
}

// ── Formatear historial ───────────────────────────────────────────────────────
function formatearMensajes(rows, titulo = "Historial") {
  if (!rows || rows.length === 0) return null;

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
      const contenido = isMedia ? `[📷 Foto${r[7] ? `: ${r[7]}` : ""}]` : (r[5] || "").slice(0, 200);
      lines.push(`${hora} ${quien}: ${contenido}`);
    }
  }
  return lines.join("\n");
}

// ── Formatear ficha de cliente desde CRM ─────────────────────────────────────
function formatearFichaCRM(row) {
  // Columnas CRM: FECHA_REG, TELEFONO, NOMBRE, EMAIL, UBICACION, ZONA,
  // PROYECTO, FECHA_VISITA, HORA_VISITA, ESTADO, VISITA_REALIZADA,
  // COT_ENVIADA, MONTO_COTIZADO, MONTO_CONTRATADO, EXTRAS, TOTAL,
  // FECHA_ULT_CONT, RESPONSABLE, NOTAS
  const [fechaReg, tel, nombre, email, ubicacion, zona,
         proyecto, fechaVisita, horaVisita, estado, visitaReal,
         cotEnviada, montoCot, montoContrat, extras, total,
         fechaUlt, responsable, notas] = row;

  const lines = [
    `👤 *${nombre || "Sin nombre"}*`,
    `📱 ${tel || "—"}`,
    email       && `📧 ${email}`,
    zona        && `📍 Zona: ${zona}`,
    proyecto    && `🏗️ Proyecto: ${proyecto}`,
    estado      && `📊 Estado: ${estado}`,
    fechaVisita && `📅 Visita: ${fechaVisita}${horaVisita ? ` a las ${horaVisita}` : ""}`,
    ubicacion   && `🗺️ Ubicación: ${ubicacion}`,
    montoCot    && `💰 Cotización: ${montoCot}`,
    montoContrat && `✅ Contratado: ${montoContrat}`,
    notas       && `📝 Notas: ${notas}`,
  ].filter(Boolean).join("\n");

  return lines;
}

// ── Triggers de memoria ───────────────────────────────────────────────────────
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
  /info\s+(de\s+)?/i,
  /ficha\s+(de\s+)?/i,
  /datos\s+(de\s+)?/i,
];

function esConsultaMemoria(text) {
  return MEMORY_TRIGGERS.some(re => re.test(text));
}

// ── Procesar consulta ─────────────────────────────────────────────────────────
async function procesarConsultaMemoria(text) {
  if (!esConsultaMemoria(text)) return null;

  const normalText = normalizar(text);

  try {

    // ── Listar clientes → desde CRM ─────────────────────────────────────────
    if (/listar?.*(clientes?|activos?)/.test(normalText)) {
      const clientes = await listarClientesCRM(30);
      if (!clientes.length) return "📭 No hay clientes en el CRM aún.";

      const lines = clientes.map(r => {
        const nombre  = r[2] || r[1] || "—";
        const tel     = r[1] || "—";
        const estado  = r[9] || "—";
        const zona    = r[5] || "—";
        return `📱 ${tel} — *${nombre}* | ${zona} | ${estado}`;
      });

      return `👥 *Clientes en CRM (${clientes.length}):*\n\n${lines.join("\n")}`;
    }

    // ── Info/Ficha de cliente → desde CRM ───────────────────────────────────
    const infoMatch = text.match(/(?:info|ficha|datos)\s+(?:de\s+)?(.+)/i);
    if (infoMatch) {
      const query    = infoMatch[1].replace(/[?.!].*$/, "").trim();
      const clientes = await buscarClienteEnCRM(query);
      if (!clientes.length) return `📭 No encontré a "${query}" en el CRM.`;

      const fichas = clientes.slice(0, 3).map(r => formatearFichaCRM(r));
      return fichas.join("\n\n─────────────\n\n");
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
      const rows    = await buscarPorContenido(keyword);
      if (!rows.length) return `📭 No encontré mensajes con "${keyword}".`;
      return formatearMensajes(rows, `Resultados: "${keyword}"`) || `📭 Sin resultados para "${keyword}".`;
    }

    // ── Historial por teléfono ───────────────────────────────────────────────
    const phoneMatch = text.match(/[+]?506\s*(\d{4}[\s-]?\d{4})/);
    if (phoneMatch) {
      const phone = "506" + phoneMatch[1].replace(/\D/g, "");
      const rows  = await buscarPorTelefono(phone);
      if (!rows.length) {
        // Intentar buscar en CRM igualmente
        const crmRows = await buscarClienteEnCRM(phone);
        if (crmRows.length) {
          return `📭 No hay conversaciones de +${phone} en WhatsApp aún.\n\n` + formatearFichaCRM(crmRows[0]);
        }
        return `📭 No encontré conversaciones de +${phone}.`;
      }
      const clientName = rows[0][2] || phone;
      return formatearMensajes(rows, `Historial de ${clientName} (+${phone})`) || `📭 Sin mensajes de +${phone}.`;
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
        if (!rows.length) {
          // Buscar en CRM si no hay conversaciones aún
          const crmRows = await buscarClienteEnCRM(nombre);
          if (crmRows.length) {
            return `📭 No hay conversaciones de "${nombre}" en WhatsApp aún.\n\n*Ficha CRM:*\n` + formatearFichaCRM(crmRows[0]);
          }
          return `📭 No encontré conversaciones de "${nombre}".`;
        }

        const phone      = rows[0][1];
        const clientName = rows[0][2] || nombre;
        return formatearMensajes(rows, `Historial de ${clientName} (${phone})`) || `📭 Sin mensajes de "${nombre}".`;
      }
    }

    // ── Fallback ─────────────────────────────────────────────────────────────
    return [
      "🧠 *Comandos disponibles:*",
      "",
      "📋 *Clientes y datos (CRM):*",
      "  • `listar clientes`",
      "  • `info [nombre]` — ficha completa del cliente",
      "  • `datos de [nombre o número]`",
      "",
      "💬 *Conversaciones WhatsApp:*",
      "  • `historial [nombre o número]`",
      "  • `qué habló [nombre]`",
      "  • `fotos de [nombre]`",
      "  • `buscar [palabra clave]`",
    ].join("\n");

  } catch (err) {
    console.error("❌ Memoria: error procesando consulta:", err.message);
    return `❌ Error al buscar en memoria: ${err.message}`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function normalizar(str) {
  return (str || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
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
