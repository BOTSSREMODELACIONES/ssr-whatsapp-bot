/**
 * memoria.js — Sistema de Memoria Persistente para Sasha
 * SSR Remodelaciones
 *
 * COLUMNAS MENSAJES (A:F):
 *   A = Fecha y Hora
 *   B = Número de Teléfono
 *   C = Nombre de Contacto
 *   D = Entrada / Salida  (in / out)
 *   E = Tipo              (text / image / audio / video)
 *   F = Mensaje
 *
 * COLUMNAS CLIENTES (A:H):
 *   A = Teléfono
 *   B = Nombre
 *   C = Proyecto
 *   D = Zona
 *   E = Primera Actividad
 *   F = Última Actividad
 *   G = Total Mensajes
 *   H = Visita Agendada
 */

const { google } = require("googleapis");
const { Readable } = require("stream");

// ── Constantes ────────────────────────────────────────────────────────────────
const DARWIN_EMAIL    = "proyectos@ssremodelaciones.com";
const SHEET_TITLE     = "SSR_Memoria_Chats";
const TZ              = "America/Costa_Rica";
const CRM_SHEET_ID    = "1LOUDwOe8W5pAF0QV0lTqC9uCcQ0fc_JaIMcGu2f5aZ4";
const MEDIA_PARENT_ID = process.env.MEDIA_FOLDER_ID || null;

let _sheetId = process.env.MEMORY_SHEET_ID || null;
const _folderCache = {};

// Cache de nombres ya conocidos por teléfono (en memoria RAM)
const _nombreCache = {};

// ── Auth ──────────────────────────────────────────────────────────────────────
async function getAuth() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  return new google.auth.JWT({
    email:  creds.client_email,
    key:    creds.private_key,
    scopes: [
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

  // Crear sheet con headers correctos
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
                "Fecha y Hora",
                "Número de Teléfono",
                "Nombre de Contacto",
                "Entrada / Salida",
                "Tipo",
                "Mensaje",
              ].map(v => ({
                userEnteredValue: { stringValue: v },
                userEnteredFormat: { textFormat: { bold: true } },
              })),
            }],
          }],
        },
        {
          properties: { title: "CLIENTES", index: 1 },
          data: [{
            startRow: 0, startColumn: 0,
            rowData: [{
              values: [
                "Teléfono",
                "Nombre",
                "Proyecto",
                "Zona",
                "Primera Actividad",
                "Última Actividad",
                "Total Mensajes",
                "Visita Agendada",
              ].map(v => ({
                userEnteredValue: { stringValue: v },
                userEnteredFormat: { textFormat: { bold: true } },
              })),
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
  } catch (e) {
    console.warn("⚠️ Memoria: no se pudo compartir el sheet:", e.message);
  }

  return _sheetId;
}

// ── Guardar mensaje en Google Sheets ─────────────────────────────────────────
// MENSAJES tiene 6 columnas: Fecha|Teléfono|Nombre|Dirección|Tipo|Mensaje
async function guardarMensaje({ phone, clientName, direction, type, content, mediaId = "", driveUrl = "", session = null }) {
  try {
    const sheetId = await getOrCreateSheetId();
    const sheets  = await getSheetsClient();

    const timestamp = new Date().toISOString();
    const nombre    = clientName || session?.name || "";

    // Construir el contenido del mensaje incluyendo mediaId/driveUrl si aplica
    let mensajeCol = content || "";
    if (type === "image") {
      if (driveUrl) {
        mensajeCol = `[Foto enviada por el cliente] ${driveUrl}`;
      } else if (mediaId) {
        mensajeCol = `[Foto enviada por el cliente] ID:${mediaId}`;
      } else {
        mensajeCol = "[Foto enviada por el cliente]";
      }
    }

    // ── Escribir fila en MENSAJES (6 columnas A:F) ────────────────────────────
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: "MENSAJES!A:F",
      valueInputOption: "RAW",
      requestBody: {
        values: [[timestamp, phone, nombre, direction, type, mensajeCol]],
      },
    });

    // ── Si obtuvimos un nombre nuevo, rellenar filas anteriores vacías ────────
    if (nombre && nombre.trim() && nombre !== _nombreCache[phone]) {
      _nombreCache[phone] = nombre;
      rellenarNombresAnteriores(sheetId, sheets, phone, nombre)
        .catch(e => console.warn("⚠️ Memoria: error rellenando nombres anteriores:", e.message));
    }

    // ── Actualizar resumen CLIENTES ───────────────────────────────────────────
    const proyecto = session?.project_desc || "";
    const zona     = session?.zone || "";
    actualizarCliente(sheetId, sheets, phone, nombre, proyecto, zona, session?.visit_confirmed || false)
      .catch(e => console.warn("⚠️ Memoria: no se actualizó CLIENTES:", e.message));

  } catch (err) {
    console.error("❌ Memoria: error guardando mensaje:", err.message);
  }
}

// ── Rellenar nombres vacíos en filas anteriores ───────────────────────────────
async function rellenarNombresAnteriores(sheetId, sheets, phone, nombre) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: "MENSAJES!A:C",
    });

    const rows = res.data.values || [];
    if (rows.length < 2) return;

    const cleanPhone = phone.replace(/\D/g, "");
    const data = [];

    for (let i = 1; i < rows.length; i++) {
      const rowPhone  = (rows[i][1] || "").replace(/\D/g, "");
      const rowNombre = rows[i][2] || "";
      if (rowPhone.endsWith(cleanPhone.slice(-8)) && !rowNombre.trim()) {
        data.push({
          range: `MENSAJES!C${i + 1}`,
          values: [[nombre]],
        });
      }
    }

    if (data.length === 0) return;

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { valueInputOption: "RAW", data },
    });

    console.log(`✅ Memoria: nombre "${nombre}" aplicado a ${data.length} filas anteriores de ${phone}`);
  } catch (err) {
    console.error("❌ Memoria: error en rellenarNombresAnteriores:", err.message);
  }
}

// ── Actualizar resumen de cliente en CLIENTES (A:H) ───────────────────────────
async function actualizarCliente(sheetId, sheets, phone, nombre, proyecto, zona, visitaAgendada) {
  const res  = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "CLIENTES!A:H" });
  const rows = res.data.values || [];
  const now  = new Date().toISOString();

  // Buscar fila existente (saltar header en fila 1)
  const idx = rows.findIndex((r, i) => i > 0 && r[0] === phone);

  if (idx === -1) {
    // Cliente nuevo — agregar fila
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: "CLIENTES!A:H",
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          phone,
          nombre,
          proyecto,
          zona,
          now,   // Primera actividad
          now,   // Última actividad
          "1",   // Total mensajes
          visitaAgendada ? "Sí" : "No",
        ]],
      },
    });
  } else {
    // Cliente existente — actualizar
    const prev      = rows[idx];
    const rowNum    = idx + 1;
    const nuevoTotal = (parseInt(prev[6] || "0") + 1).toString();

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `CLIENTES!A${rowNum}:H${rowNum}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          phone,
          nombre   || prev[1] || "",   // Nombre: usar el nuevo si existe
          proyecto || prev[2] || "",   // Proyecto
          zona     || prev[3] || "",   // Zona
          prev[4]  || now,             // Primera actividad (preservar)
          now,                         // Última actividad
          nuevoTotal,                  // Total mensajes
          visitaAgendada ? "Sí" : (prev[7] || "No"),
        ]],
      },
    });
  }
}

// ── Leer clientes del CRM principal ──────────────────────────────────────────
async function listarClientesCRM(limit = 30) {
  try {
    const sheets = await getSheetsClient();
    const res    = await sheets.spreadsheets.values.get({
      spreadsheetId: CRM_SHEET_ID,
      range: "'CRM Clientes'!A:S",
    });
    const rows = (res.data.values || []).slice(2);
    return rows.filter(r => r[1] && r[1].toString().trim() !== "").slice(-limit);
  } catch (err) {
    console.error("❌ Memoria: error leyendo CRM:", err.message);
    return [];
  }
}

async function buscarClienteEnCRM(query) {
  try {
    const sheets = await getSheetsClient();
    const res    = await sheets.spreadsheets.values.get({
      spreadsheetId: CRM_SHEET_ID,
      range: "'CRM Clientes'!A:S",
    });
    const rows        = (res.data.values || []).slice(2);
    const kw          = normalizar(query);
    const soloDigitos = query.replace(/\D/g, "");

    return rows.filter(r => {
      const nombre   = normalizar(r[2] || "");
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
    const ext      = (mimeType.split("/")[1] || "jpg").replace("jpeg", "jpg");
    const ts       = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file     = await drive.files.create({
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

async function getOrCreateMediaFolder(drive, phone, clientName) {
  if (_folderCache[phone]) return _folderCache[phone];
  const safeName   = (clientName || "").replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ\s]/g, "").trim().slice(0, 25);
  const folderName = `Chats_${phone}${safeName ? `_${safeName}` : ""}`;
  const q          = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const search     = await drive.files.list({ q, fields: "files(id)", spaces: "drive" });

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

// ── Funciones de búsqueda ─────────────────────────────────────────────────────
// MENSAJES col index: 0=fecha, 1=tel, 2=nombre, 3=dir, 4=tipo, 5=mensaje
async function buscarPorTelefono(phone, limit = 60) {
  const sheetId = await getOrCreateSheetId();
  const sheets  = await getSheetsClient();
  const res     = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "MENSAJES!A:F" });
  const rows    = (res.data.values || []).slice(1);
  const clean   = phone.replace(/\D/g, "");
  return rows.filter(r => (r[1] || "").replace(/\D/g, "").endsWith(clean)).slice(-limit);
}

async function buscarPorNombre(nombre, limit = 60) {
  const sheetId = await getOrCreateSheetId();
  const sheets  = await getSheetsClient();
  const res     = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "MENSAJES!A:F" });
  const rows    = (res.data.values || []).slice(1);
  const kw      = normalizar(nombre);
  return rows.filter(r => normalizar(r[2] || "").includes(kw) || normalizar(r[5] || "").includes(kw)).slice(-limit);
}

async function buscarPorContenido(keyword, limit = 30) {
  const sheetId = await getOrCreateSheetId();
  const sheets  = await getSheetsClient();
  const res     = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "MENSAJES!A:F" });
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
  // Las fotos están en tipo (col 4) y el link en mensaje (col 5)
  return rows.filter(r => r[4] === "image" && (r[5] || "").includes("http"));
}

// ── Formatear historial ───────────────────────────────────────────────────────
// col: 0=fecha, 1=tel, 2=nombre, 3=dir(in/out), 4=tipo, 5=mensaje
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
      const contenido = (r[5] || "").slice(0, 200);
      lines.push(`${hora} ${quien}: ${contenido}`);
    }
  }
  return lines.join("\n");
}

function formatearFichaCRM(row) {
  const [fechaReg, tel, nombre, email, ubicacion, zona,
         proyecto, fechaVisita, horaVisita, estado, visitaReal,
         cotEnviada, montoCot, montoContrat, extras, total,
         fechaUlt, responsable, notas] = row;
  return [
    `👤 *${nombre || "Sin nombre"}*`,
    `📱 ${tel || "—"}`,
    email        && `📧 ${email}`,
    zona         && `📍 Zona: ${zona}`,
    proyecto     && `🏗️ Proyecto: ${proyecto}`,
    estado       && `📊 Estado: ${estado}`,
    fechaVisita  && `📅 Visita: ${fechaVisita}${horaVisita ? ` a las ${horaVisita}` : ""}`,
    ubicacion    && `🗺️ Ubicación: ${ubicacion}`,
    montoCot     && `💰 Cotización: ${montoCot}`,
    montoContrat && `✅ Contratado: ${montoContrat}`,
    notas        && `📝 Notas: ${notas}`,
  ].filter(Boolean).join("\n");
}

async function resumirConversacion(rows, clientName, phone) {
  if (!rows || rows.length === 0) return null;
  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const mensajesTexto = rows.slice(-50).map(r => {
      const hora  = new Date(r[0]).toLocaleString("es-CR", { timeZone: TZ, dateStyle: "short", timeStyle: "short" });
      const quien = r[3] === "in" ? "Cliente" : "Sasha";
      const msg   = r[4] === "image" ? "[Foto enviada]" : (r[5] || "");
      return `[${hora}] ${quien}: ${msg.slice(0, 300)}`;
    }).join("\n");

    const fotos = rows.filter(r => r[4] === "image" && (r[5] || "").includes("http"));

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      system: `Sos asistente de SS Remodelaciones. Resumí esta conversación de WhatsApp entre Sasha y un cliente.
Formato de respuesta (WhatsApp, conciso):
- Qué quiere el cliente (en 1-2 líneas)
- Estado actual (¿agendó visita? ¿está cotizando? ¿pendiente de respuesta?)
- Puntos importantes mencionados
- NO incluyas los mensajes literales, solo el resumen`,
      messages: [{ role: "user", content: `Cliente: ${clientName || phone}\n\nConversación:\n${mensajesTexto}` }],
    });
    const resumen = response.content[0]?.text?.trim() || "";
    const lines = [`📋 *Resumen — ${clientName || phone}*`, `📱 ${phone}`, "", resumen];
    if (fotos.length > 0) {
      lines.push("", `📷 *Fotos enviadas (${fotos.length}):*`);
      fotos.slice(-10).forEach(r => {
        const hora = new Date(r[0]).toLocaleString("es-CR", { timeZone: TZ, dateStyle: "short" });
        lines.push(`  • ${hora}: ${r[5]}`);
      });
    }
    return lines.join("\n");
  } catch (err) {
    console.warn("⚠️ Memoria: error resumiendo:", err.message);
    return formatearMensajes(rows, `Historial de ${clientName || phone}`);
  }
}

// ── Triggers de memoria ───────────────────────────────────────────────────────
const MEMORY_TRIGGERS = [
  /historial/i,
  /qu[eé]\s+(hab[ló]|dij[oi]|mand[oó]|escrib|hablaste|conversaste)/i,
  /conversaci[oó]n/i,
  /fotos?\s+de/i,
  /videos?\s+de/i,
  /listar?\s+clientes?/i,
  /buscar?\s+/i,
  /cu[aá]ntos?\s+mensajes?/i,
  /[+]506[\s\d]{8,}/,
  /mem[oó]ria/i,
  /cliente[s]?\s+activos?/i,
  /info\s+(de\s+)?/i,
  /ficha\s+(de\s+)?/i,
  /datos\s+(de\s+)?/i,
  /res[uú]me(n|[nm]e)\s+(la\s+)?conversaci[oó]n/i,
  /d[ií]me\s+(qu[eé]|c[oó]mo)/i,
  /cu[eé]ntame\s+(qu[eé]|c[oó]mo)/i,
  /qu[eé]\s+pas[oó]\s+(con|de)/i,
  /medios?\s+de/i,
  /archivos?\s+de/i,
];

function esConsultaMemoria(text) {
  return MEMORY_TRIGGERS.some(re => re.test(text));
}

// ── Procesar consulta ─────────────────────────────────────────────────────────
async function procesarConsultaMemoria(text) {
  if (!esConsultaMemoria(text)) return null;
  const normalText = normalizar(text);

  try {
    if (/listar?.*(clientes?|activos?)/.test(normalText)) {
      const clientes = await listarClientesCRM(30);
      if (!clientes.length) return "📭 No hay clientes en el CRM aún.";
      const lines = clientes.map(r => {
        const nombre = r[2] || r[1] || "—";
        const tel    = r[1] || "—";
        const estado = r[9] || "—";
        const zona   = r[5] || "—";
        return `📱 ${tel} — *${nombre}* | ${zona} | ${estado}`;
      });
      return `👥 *Clientes en CRM (${clientes.length}):*\n\n${lines.join("\n")}`;
    }

    const infoMatch = text.match(/(?:info|ficha|datos)\s+(?:de\s+)?(.+)/i);
    if (infoMatch) {
      const query    = infoMatch[1].replace(/[?.!].*$/, "").trim();
      const clientes = await buscarClienteEnCRM(query);
      if (!clientes.length) return `📭 No encontré a "${query}" en el CRM.`;
      return clientes.slice(0, 3).map(r => formatearFichaCRM(r)).join("\n\n─────────────\n\n");
    }

    const fotosMatch = text.match(/fotos?\s+de\s+(.+)/i);
    if (fotosMatch) {
      const query = fotosMatch[1].replace(/[?.!].*$/, "").trim();
      const fotos = await obtenerFotos(query);
      if (!fotos.length) return `📭 No encontré fotos de "${query}".`;
      const lines = fotos.slice(-20).map(r => {
        const hora = new Date(r[0]).toLocaleString("es-CR", { timeZone: TZ });
        return `📷 ${hora}: ${r[5]}`;
      });
      return `📷 *Fotos de ${query}* (${fotos.length}):\n\n${lines.join("\n")}`;
    }

    const buscarMatch = text.match(/buscar?\s+(.+)/i);
    if (buscarMatch) {
      const keyword = buscarMatch[1].replace(/[?.!].*$/, "").trim();
      const rows    = await buscarPorContenido(keyword);
      if (!rows.length) return `📭 No encontré mensajes con "${keyword}".`;
      return formatearMensajes(rows, `Resultados: "${keyword}"`) || `📭 Sin resultados para "${keyword}".`;
    }

    const phoneMatch = text.match(/[+]?506\s*(\d{4}[\s-]?\d{4})/);
    if (phoneMatch) {
      const phone = "506" + phoneMatch[1].replace(/\D/g, "");
      const rows  = await buscarPorTelefono(phone);
      if (!rows.length) {
        const crmRows = await buscarClienteEnCRM(phone);
        if (crmRows.length) return `📭 No hay conversaciones de +${phone} en WhatsApp aún.\n\n` + formatearFichaCRM(crmRows[0]);
        return `📭 No encontré conversaciones de +${phone}.`;
      }
      const clientName = rows[0][2] || phone;
      return formatearMensajes(rows, `Historial de ${clientName} (+${phone})`) || `📭 Sin mensajes de +${phone}.`;
    }

    const resumenPatterns = [
      /(?:d[ií]me|cu[eé]ntame)\s+(?:qu[eé]|c[oó]mo)\s+(?:hab[ló]|fue|anda|est[aá])\s+(?:con\s+)?(.+)/i,
      /res[uú]me(?:n|me)?\s+(?:la\s+)?conversaci[oó]n\s+(?:de\s+|con\s+)?(.+)/i,
      /qu[eé]\s+pas[oó]\s+(?:con|de)\s+(.+)/i,
      /c[oó]mo\s+va\s+(?:el\s+|la\s+)?(?:cliente\s+)?(.+)/i,
    ];

    for (const pattern of resumenPatterns) {
      const match = text.match(pattern);
      if (match) {
        const nombre = match[1].replace(/[?.!].*$/, "").trim();
        if (nombre.length < 3) continue;
        const rows = await buscarPorNombre(nombre);
        if (!rows.length) {
          const crmRows = await buscarClienteEnCRM(nombre);
          if (crmRows.length) return `📭 No hay conversaciones de "${nombre}" en WhatsApp aún.\n\n*Ficha CRM:*\n` + formatearFichaCRM(crmRows[0]);
          return `📭 No encontré conversaciones de "${nombre}".`;
        }
        const phone      = rows[0][1];
        const clientName = rows[0][2] || nombre;
        return await resumirConversacion(rows, clientName, phone) || `📭 Sin mensajes de "${nombre}".`;
      }
    }

    const nombrePatterns = [
      /historial\s+(?:de\s+)?(.+)/i,
      /qu[eé]\s+(?:hab[ló]|dij[oi]|mand[oó]|hablaste|conversaste)\s+(?:con\s+)?(.+)/i,
      /conversaci[oó]n\s+(?:de\s+)?(.+)/i,
      /cu[aá]ntos?\s+mensajes?\s+(?:de\s+|tiene\s+)?(.+)/i,
      /medios?\s+(?:de|enviados?\s+(?:por|de))\s+(.+)/i,
      /archivos?\s+(?:de|enviados?\s+(?:por|de))\s+(.+)/i,
    ];

    for (const pattern of nombrePatterns) {
      const match = text.match(pattern);
      if (match) {
        const nombre = match[1].replace(/[?.!].*$/, "").trim();
        if (nombre.length < 3) continue;
        const rows = await buscarPorNombre(nombre);
        if (!rows.length) {
          const crmRows = await buscarClienteEnCRM(nombre);
          if (crmRows.length) return `📭 No hay conversaciones de "${nombre}" en WhatsApp aún.\n\n*Ficha CRM:*\n` + formatearFichaCRM(crmRows[0]);
          return `📭 No encontré conversaciones de "${nombre}".`;
        }
        const phone      = rows[0][1];
        const clientName = rows[0][2] || nombre;
        if (/fotos?|medios?|archivos?|im[aá]genes?/i.test(text)) {
          const fotos = rows.filter(r => r[4] === "image" && (r[5] || "").includes("http"));
          if (!fotos.length) return `📭 No encontré fotos de "${nombre}".`;
          const lines = [`📎 *Fotos de ${clientName}:*`, ""];
          fotos.slice(-15).forEach(r => {
            const hora = new Date(r[0]).toLocaleString("es-CR", { timeZone: TZ, dateStyle: "short" });
            lines.push(`  • ${hora} → ${r[5]}`);
          });
          return lines.join("\n");
        }
        return formatearMensajes(rows, `Historial de ${clientName} (${phone})`) || `📭 Sin mensajes de "${nombre}".`;
      }
    }

    return [
      "🧠 *Comandos disponibles:*", "",
      "📋 *Clientes y datos (CRM):*",
      "  • `listar clientes`",
      "  • `info [nombre]` — ficha completa del cliente",
      "  • `datos de [nombre o número]`", "",
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
  listarClientesCRM,
  buscarClienteEnCRM,
  obtenerFotos,
  formatearMensajes,
  esConsultaMemoria,
  procesarConsultaMemoria,
};
