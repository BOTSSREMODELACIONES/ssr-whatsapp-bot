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
 *
 * ── CAMBIOS v2 ────────────────────────────────────────────────────────────────
 * BUGS CORREGIDOS:
 *   - "resumen de la conversación con X" ahora captura "X" (no "con X")
 *   - Patrón conversacion ahora maneja preposición "con" además de "de"
 *   - MEMORY_TRIGGERS simplificado: /resumen/i cubre todos los casos
 *
 * NUEVO — SOPORTE AUDIO/VOZ:
 *   - detectarComandoVoz(text): parsea lenguaje natural transcrito de audios
 *     para GASTO, INGRESO, MSG_CLIENTE y RESUMEN desde Darwin
 *   - parsearMontoEspanol(texto): convierte "cincuenta mil", "15 mil",
 *     "cien mil quinientos" → número entero
 *   - MEMORY_TRIGGERS y patrones de nombre ampliados para voz natural
 * ─────────────────────────────────────────────────────────────────────────────
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
async function guardarMensaje({ phone, clientName, direction, type, content, mediaId = "", driveUrl = "", session = null }) {
  try {
    const sheetId = await getOrCreateSheetId();
    const sheets  = await getSheetsClient();

    const timestamp = new Date().toISOString();
    const nombre    = clientName || session?.name || "";

    let mensajeCol = content || "";
    if (type === "image") {
      if (driveUrl)      mensajeCol = `[Foto enviada por el cliente] ${driveUrl}`;
      else if (mediaId)  mensajeCol = `[Foto enviada por el cliente] ID:${mediaId}`;
      else               mensajeCol = "[Foto enviada por el cliente]";
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: "MENSAJES!A:F",
      valueInputOption: "RAW",
      requestBody: {
        values: [[timestamp, phone, nombre, direction, type, mensajeCol]],
      },
    });

    if (nombre && nombre.trim() && nombre !== _nombreCache[phone]) {
      _nombreCache[phone] = nombre;
      rellenarNombresAnteriores(sheetId, sheets, phone, nombre)
        .catch(e => console.warn("⚠️ Memoria: error rellenando nombres anteriores:", e.message));
    }

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
        data.push({ range: `MENSAJES!C${i + 1}`, values: [[nombre]] });
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

  const idx = rows.findIndex((r, i) => i > 0 && r[0] === phone);

  if (idx === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: "CLIENTES!A:H",
      valueInputOption: "RAW",
      requestBody: {
        values: [[phone, nombre, proyecto, zona, now, now, "1", visitaAgendada ? "Sí" : "No"]],
      },
    });
  } else {
    const prev       = rows[idx];
    const rowNum     = idx + 1;
    const nuevoTotal = (parseInt(prev[6] || "0") + 1).toString();

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `CLIENTES!A${rowNum}:H${rowNum}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          phone,
          nombre   || prev[1] || "",
          proyecto || prev[2] || "",
          zona     || prev[3] || "",
          prev[4]  || now,
          now,
          nuevoTotal,
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
  return rows.filter(r => r[4] === "image" && (r[5] || "").includes("http"));
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

// ═══════════════════════════════════════════════════════════════════════════════
// PARSEO DE MONTOS EN ESPAÑOL COSTARRICENSE
// ═══════════════════════════════════════════════════════════════════════════════

const NUMEROS_ES = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
  trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17,
  dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintidos: 22,
  veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26,
  veintisiete: 27, veintiocho: 28, veintinueve: 29, treinta: 30, cuarenta: 40,
  cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
  cien: 100, ciento: 100, doscientos: 200, doscientas: 200,
  trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400,
  quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600,
  setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800,
  novecientos: 900, novecientas: 900, medio: 500,
};

/**
 * Convierte texto numérico en español a número entero.
 * Ejemplos:
 *   "cincuenta mil"        → 50000
 *   "15 mil"               → 15000
 *   "ciento veinte mil"    → 120000
 *   "un millon"            → 1000000
 *   "medio millon"         → 500000
 *   "15,000"               → 15000
 *   "₡50.000"              → 50000
 *   "15000"                → 15000
 */
function parsearMontoEspanol(texto) {
  if (!texto) return null;

  // Limpiar símbolo de colón y espacios
  let t = texto.toLowerCase()
    .replace(/[₡$]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Número directo con puntos o comas como separadores de miles: "50.000", "50,000"
  const numPuntos = t.match(/^(\d{1,3}(?:[.,]\d{3})+)$/);
  if (numPuntos) return parseInt(t.replace(/[.,]/g, ""));

  // Número directo simple: "50000"
  const numSimple = t.match(/^(\d+)$/);
  if (numSimple) return parseInt(t);

  // "X.Y mil" o "X,Y mil" → fraccional: "1.5 mil" → 1500
  const fracMil = t.match(/^(\d+)[.,](\d+)\s*mil(?:es)?$/);
  if (fracMil) return Math.round(parseFloat(`${fracMil[1]}.${fracMil[2]}`) * 1000);

  // Normalizar para palabras
  const norm = t
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\bde\s+(mil|millon)/g, "$1")
    .replace(/\s+y\s+/g, " ");

  // Detectar millones
  const millonesMatch = norm.match(/^(.+?)\s+millon(?:es)?(.*)$/);
  if (millonesMatch) {
    const baseMillon   = calcularValorPalabras(millonesMatch[1].trim());
    const resto        = millonesMatch[2].trim();
    const restoValor   = resto ? calcularValorPalabras(resto.replace(/^\s*(?:y\s+)?/, "").trim()) : 0;
    if (baseMillon !== null) return (baseMillon === 500 ? 500000 : baseMillon * 1000000) + (restoValor || 0);
  }

  // Detectar miles
  const milesMatch = norm.match(/^(.+?)\s+mil(?:es)?(.*)$/);
  if (milesMatch) {
    const baseMil  = calcularValorPalabras(milesMatch[1].trim());
    const restoMil = milesMatch[2].trim();
    const restoVal = restoMil ? calcularValorPalabras(restoMil.replace(/^\s*(?:y\s+)?/, "").trim()) : 0;
    if (baseMil !== null) return baseMil * 1000 + (restoVal || 0);
  }

  // Solo palabras sin "mil"
  const soloWords = calcularValorPalabras(norm);
  return soloWords;
}

/** Suma palabras numéricas españolas: "ciento veinte" → 120 */
function calcularValorPalabras(texto) {
  if (!texto) return 0;
  const partes = texto.split(/\s+/);
  let total = 0;
  let found = false;
  for (const p of partes) {
    const v = NUMEROS_ES[p.replace(/[\u0300-\u036f]/g, "").normalize("NFD")];
    if (v !== undefined) { total += v; found = true; }
    else {
      const n = parseInt(p);
      if (!isNaN(n)) { total += n; found = true; }
    }
  }
  return found ? total : null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DETECCIÓN DE COMANDOS POR VOZ (AUDIOS TRANSCRITOS)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detecta si un texto transcrito de audio de Darwin contiene un comando
 * de supervisor: GASTO, INGRESO, MSG_CLIENTE o RESUMEN_CLIENTE.
 *
 * Retorna { tipo, payload } o null si no detecta ningún comando.
 *
 * tipo puede ser: "GASTO" | "INGRESO" | "MSG_CLIENTE" | "RESUMEN_CLIENTE"
 *
 * Ejemplos de entrada → salida:
 *   "anota un gasto de cincuenta mil en materiales"
 *     → { tipo: "GASTO", payload: "50000 | materiales" }
 *
 *   "registra un ingreso de 80 mil por la visita de Juan"
 *     → { tipo: "INGRESO", payload: "80000 | visita de Juan" }
 *
 *   "mándale a teresita que su presupuesto ya está listo"
 *     → { tipo: "MSG_CLIENTE", payload: "teresita | su presupuesto ya está listo" }
 *
 *   "dame el resumen de teresita"
 *     → { tipo: "RESUMEN_CLIENTE", payload: "teresita" }
 *
 * En index.js, después de transcribir el audio del supervisor:
 *   const cmdVoz = memoria.detectarComandoVoz(textoTranscrito);
 *   if (cmdVoz) {
 *     // Construir comando estructurado y procesar igual que si Darwin lo hubiera escrito
 *     const estructurado = `[${cmdVoz.tipo}: ${cmdVoz.payload}]`;
 *     // ... llama al handler de ese comando
 *   }
 */
function detectarComandoVoz(text) {
  if (!text || !text.trim()) return null;
  const t = text.trim();

  // ── GASTO ──────────────────────────────────────────────────────────────────
  // Reconoce frases naturales:
  // "descuenta 200mil de gas y aceite para Pick Up, proyecto Marriot"
  // "apunta 19500 al Marriot por comida"
  // "rebaja 80 mil de materiales Karim"
  // "pagué 25 mil de gasolina proyecto Laura"
  const gastoRe = /^(?:(?:anota?r?|registra?r?|agrega?r?|escrib(?:e|ir)|apunta?r?|carga?r?|carg[aá]me|descuenta?r?|descont[aá]r?|rebaja?r?|saca?r?|pag(?:u[eé]|ar|ue)|compr(?:e|é|ar)|gast(?:e|é|ar)|met(?:e|er))\s+)?(?:un\s+)?(?:gasto\s+(?:de\s+)?|pago\s+(?:de\s+)?|compra\s+(?:de\s+)?|)(.+)$/i;
  const gm = t.match(gastoRe);
  if (gm && /(gasto|pago|compra|compr[eé]|gast[eé]|descuenta|descont|rebaja|saca|apunta|carga|pag[ué]|material|gas|aceite|gasolina|diesel|di[eé]sel|ferreter|epa|construplaza|marriot|marriott|karim|laura|miriam|nathalie|jeannette)/i.test(t)) {
    const { monto, descripcion, proyecto } = _separarMontoDesc(gm[1].trim());
    if (monto || descripcion) {
      const partes = [monto, descripcion || "Sin descripción", proyecto].filter(Boolean);
      return { tipo: "GASTO", payload: partes.join(" | ") };
    }
  }

  // ── INGRESO ────────────────────────────────────────────────────────────────
  const ingresoRe = /^(?:(?:anota?r?|registra?r?|agrega?r?|escrib(?:e|ir)|apunta?r?|carga?r?|carg[aá]me)?\s*)?(?:un\s+)?(?:(?:ingreso|pago recibido|me pagaron|pagaron|abonaron|abono|adelanto|dep[oó]sito|deposito)\s+(?:de\s+)?)(.+)$/i;
  const im = t.match(ingresoRe);
  if (im) {
    const { monto, descripcion, proyecto } = _separarMontoDesc(im[1].trim());
    if (monto || descripcion) {
      const partes = [monto, descripcion || "Ingreso cliente", proyecto].filter(Boolean);
      return { tipo: "INGRESO", payload: partes.join(" | ") };
    }
  }

  // ── MSG_CLIENTE ────────────────────────────────────────────────────────────
  const msgRe = /(?:m[aá]ndale|envi[aá]le|dec[íi]le|av[íi]sale|escr[íi]bele)\s+a\s+(.+?)\s+que\s+(.+)/i;
  const mm = t.match(msgRe);
  if (mm) {
    const nombre  = mm[1].replace(/[?.!].*$/, "").trim();
    const mensaje = mm[2].trim();
    if (nombre && mensaje) {
      return { tipo: "MSG_CLIENTE", payload: `${nombre} | ${mensaje}` };
    }
  }

  // ── RESUMEN_CLIENTE ────────────────────────────────────────────────────────
  const resumenVozRe = [
    /(?:dame|deme|mu[eé]strame)\s+(?:el\s+)?resumen\s+(?:de\s+la\s+conversaci[oó]n\s+(?:de\s+|con\s+)?|de\s+|con\s+)?(.+)/i,
    /(?:c[oó]mo)\s+(?:est[aá]|va|anda)\s+(.+)/i,
    /(?:qu[eé])\s+(?:pas[oó]|dijo|hab[ló]|mand[oó])\s+(?:con\s+)?(.+)/i,
    /resumen\s+(?:de\s+la\s+conversaci[oó]n\s+(?:de\s+|con\s+)?|de\s+|con\s+)?(.+)/i,
  ];
  for (const re of resumenVozRe) {
    const rm = t.match(re);
    if (rm) {
      const nombre = rm[1].replace(/[?.!].*$/, "").trim();
      if (nombre.length >= 3) {
        return { tipo: "RESUMEN_CLIENTE", payload: nombre };
      }
    }
  }

  return null;
}

/**
 * Separa "50 mil en materiales" → { monto: "50000", descripcion: "materiales" }
 * Maneja correctamente:
 *   - Números con separador de miles: "16,000 colones por comida" → monto 16000
 *   - Números con punto de miles: "16.000 por comida" → monto 16000
 *   - Palabras: "cincuenta mil en materiales" → monto 50000
 * Separadores de descripción reconocidos: "en", "para", "por", "de", "a nombre de"
 */
function _separarMontoDesc(texto) {
  let t = texto
    .replace(/\bcolon(?:es)?\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Extraer proyecto explícito: "proyecto Marriot", "obra Karim", "cliente Laura"
  let proyecto = "";
  const proyectoMatch = t.match(/\b(?:proyecto|obra|cliente)\s+([a-záéíóúñ0-9\s/.-]+)$/i);
  if (proyectoMatch) {
    proyecto = proyectoMatch[1].trim().replace(/[,.]+$/g, "");
    t = t.replace(proyectoMatch[0], "").trim();
  } else {
    const alMatch = t.match(/\b(?:al|a la|a el|para|de)\s+([a-záéíóúñ]+(?:\s+[a-záéíóúñ]+)?)\s*$/i);
    if (alMatch && !/gas|aceite|material|herramient|comida|almuerzo|diesel|gasolina|factura|sinpe|transferencia|pick\s*up/i.test(alMatch[1])) {
      proyecto = alMatch[1].trim().replace(/[,.]+$/g, "");
      t = t.replace(alMatch[0], "").trim();
    }
  }

  // CASO 1: monto numérico o "200mil" en cualquier posición.
  const numAnywhere = t.match(/\b(\d{1,3}(?:[.,]\d{3})+|\d{4,}|\d+\s*mil(?:lones?)?)\b/i);
  if (numAnywhere) {
    const montoRaw = numAnywhere[1];
    const monto = parsearMontoEspanol(montoRaw);
    if (monto !== null && monto > 0) {
      const idx = t.toLowerCase().indexOf(montoRaw.toLowerCase()) + montoRaw.length;
      let desc = t.slice(idx).trim();
      desc = desc.replace(/^(?:por|para|en|de|a|al|a la)\s+/i, "")
                 .replace(/^concepto\s+de\s+/i, "")
                 .replace(/\bpor\s+concepto\s+de\b/gi, "")
                 .replace(/[,\]"'.]+$/g, "")
                 .replace(/\s+/g, " ")
                 .trim();

      if (!desc || desc.length < 2) {
        let antes = t.slice(0, t.toLowerCase().indexOf(montoRaw.toLowerCase())).trim();
        antes = antes.replace(/^(?:.*?\bgasto\b|.*?\bingreso\b|.*?\bdescuenta\b|.*?\bapunta\b|.*?\brebaja\b|.*?\bpagu[eé]\b)\s*/i, "")
                     .replace(/\b(?:de|por|para|a nombre del?|a nombre de|del?)\b/gi, " ")
                     .replace(/\s+/g, " ")
                     .trim();
        desc = antes || "Sin descripción";
      }
      return { monto: String(monto), descripcion: desc || "Sin descripción", proyecto };
    }
  }

  // CASO 2: monto en palabras separado por preposición.
  const sepRe = /^(.+?)\s+(?:en|para|por|de)\s+(.+)$/i;
  const sep = t.match(sepRe);
  if (sep) {
    const monto = parsearMontoEspanol(sep[1].trim());
    if (monto !== null && monto > 0) {
      let desc = sep[2].trim().replace(/^(?:concepto\s+de\s+|el\s+|la\s+)/i, "").trim();
      return { monto: String(monto), descripcion: desc || "Sin descripción", proyecto };
    }
  }

  // CASO 3: monto en palabras al inicio.
  const numPalabrasRe = /^((?:[a-záéíóúñ]+\s+)*(?:mil(?:lones?)?|ciento[s]?|cien|quinientos?|doscientos?|trescientos?|cuatrocientos?|seiscientos?|setecientos?|ochocientos?|novecientos?))\s+(.+)$/i;
  const np = t.match(numPalabrasRe);
  if (np) {
    const monto = parsearMontoEspanol(np[1].trim());
    if (monto !== null && monto > 0) {
      let desc = np[2].trim().replace(/^(?:por|para|en|de)\s+/i, "").replace(/^concepto\s+de\s+/i, "").trim();
      return { monto: String(monto), descripcion: desc || "Sin descripción", proyecto };
    }
  }

  const monto = parsearMontoEspanol(t);
  if (monto !== null && monto > 0) return { monto: String(monto), descripcion: "", proyecto };

  return { monto: null, descripcion: t, proyecto };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRIGGERS DE MEMORIA
// ═══════════════════════════════════════════════════════════════════════════════

const MEMORY_TRIGGERS = [
  /historial/i,
  /qu[eé]\s+(hab[ló]|dij[oi]|mand[oó]|escrib|hablaste|conversaste)/i,
  /conversaci[oó]n/i,
  /resumen/i,                    // FIX: simplificado — cubre "resumen de la conversación", "dame el resumen", etc.
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
  /d[ií]me\s+(qu[eé]|c[oó]mo)/i,
  /cu[eé]ntame\s+(qu[eé]|c[oó]mo)/i,
  /qu[eé]\s+pas[oó]\s+(con|de)/i,
  /medios?\s+de/i,
  /archivos?\s+de/i,
  // Patrones para voz natural (audios transcritos)
  /c[oó]mo\s+va\s+/i,
  /c[oó]mo\s+est[aá]\s+/i,
  /qu[eé]\s+anda\s+(con|haciendo|pasando)/i,
  /mu[eé]strame\s+(el|la|los|las)/i,
  /dame\s+(el|la|los|las)\s+/i,
  /qu[eé]\s+(?:fue|dijo|hab[ló]|pas[oó]|mand[oó])\s+.{2,}/i,
];

function esConsultaMemoria(text) {
  return MEMORY_TRIGGERS.some(re => re.test(text));
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESADOR DE CONSULTAS DE MEMORIA
// ═══════════════════════════════════════════════════════════════════════════════

async function procesarConsultaMemoria(text) {
  if (!esConsultaMemoria(text)) return null;
  const normalText = normalizar(text);

  try {
    // ── Listar clientes ──────────────────────────────────────────────────────
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

    // ── Ficha/info/datos de cliente ──────────────────────────────────────────
    const infoMatch = text.match(/(?:info|ficha|datos)\s+(?:de\s+)?(.+)/i);
    if (infoMatch) {
      const query    = infoMatch[1].replace(/[?.!].*$/, "").trim();
      const clientes = await buscarClienteEnCRM(query);
      if (!clientes.length) return `📭 No encontré a "${query}" en el CRM.`;
      return clientes.slice(0, 3).map(r => formatearFichaCRM(r)).join("\n\n─────────────\n\n");
    }

    // ── Fotos de cliente ─────────────────────────────────────────────────────
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

    // ── Buscar por contenido ─────────────────────────────────────────────────
    const buscarMatch = text.match(/buscar?\s+(.+)/i);
    if (buscarMatch) {
      const keyword = buscarMatch[1].replace(/[?.!].*$/, "").trim();
      const rows    = await buscarPorContenido(keyword);
      if (!rows.length) return `📭 No encontré mensajes con "${keyword}".`;
      return formatearMensajes(rows, `Resultados: "${keyword}"`) || `📭 Sin resultados para "${keyword}".`;
    }

    // ── Historial por número de teléfono ─────────────────────────────────────
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

    // ── PATRONES DE RESUMEN (IA) ─────────────────────────────────────────────
    // FIX: agrega "de" antes de "la" en el patrón de conversación
    // NUEVO: patrones de voz natural incluidos
    const resumenPatterns = [
      // Texto escrito: "resúmeme la conversación con X" / "resumen de la conversación con X"
      /res[uú]me(?:n|me|nos?)?\s+(?:de\s+)?(?:la\s+)?conversaci[oó]n\s+(?:de\s+|con\s+)?(.+)/i,
      // Voz: "dame el resumen de X" / "deme el resumen con X"
      /(?:dame|deme)\s+(?:el\s+)?resumen\s+(?:de\s+(?:la\s+)?(?:conversaci[oó]n\s+)?(?:de\s+|con\s+)?)?(.+)/i,
      // Voz: "muéstrame el resumen de X"
      /mu[eé]strame\s+(?:el\s+)?(?:resumen|historial|conversaci[oó]n)\s+(?:de\s+|con\s+)?(.+)/i,
      // Texto: "dime qué habló X" / "cuéntame cómo va X"
      /(?:d[ií]me|cu[eé]ntame)\s+(?:qu[eé]|c[oó]mo)\s+(?:hab[ló]|fue|anda|est[aá]|va)\s+(?:con\s+)?(.+)/i,
      // Texto: "qué pasó con X"
      /qu[eé]\s+pas[oó]\s+(?:con|de)\s+(.+)/i,
      // Voz: "cómo va / cómo está [el cliente] X"
      /c[oó]mo\s+(?:va|est[aá]|anda)\s+(?:el\s+|la\s+)?(?:cliente\s+|caso\s+)?(.+)/i,
      // Voz: "qué anda pasando con X"
      /qu[eé]\s+anda\s+(?:pasando\s+)?(?:con\s+)?(.+)/i,
      // Voz: "qué dijo / qué habló / qué mandó X"
      /qu[eé]\s+(?:dijo|hab[ló]|mand[oó])\s+(.+)/i,
    ];

    for (const pattern of resumenPatterns) {
      const match = text.match(pattern);
      if (match) {
        const nombre = match[1].replace(/[?.!\s]+$/, "").trim();
        if (nombre.length < 2) continue;
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

    // ── PATRONES DE HISTORIAL (raw) ──────────────────────────────────────────
    // FIX: conversacion ahora acepta "con" además de "de"
    const nombrePatterns = [
      /historial\s+(?:de\s+)?(.+)/i,
      /qu[eé]\s+(?:hab[ló]|dij[oi]|mand[oó]|hablaste|conversaste)\s+(?:con\s+)?(.+)/i,
      /conversaci[oó]n\s+(?:de\s+|con\s+)?(.+)/i,           // FIX: agrega "con"
      /cu[aá]ntos?\s+mensajes?\s+(?:de\s+|tiene\s+)?(.+)/i,
      /medios?\s+(?:de|enviados?\s+(?:por|de))\s+(.+)/i,
      /archivos?\s+(?:de|enviados?\s+(?:por|de))\s+(.+)/i,
    ];

    for (const pattern of nombrePatterns) {
      const match = text.match(pattern);
      if (match) {
        const nombre = match[1].replace(/[?.!\s]+$/, "").trim();
        if (nombre.length < 2) continue;
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

    // ── Fallback: ayuda ──────────────────────────────────────────────────────
    return [
      "🧠 *Comandos disponibles:*", "",
      "📋 *Clientes y datos (CRM):*",
      "  • `listar clientes`",
      "  • `info [nombre]` — ficha completa del cliente",
      "  • `datos de [nombre o número]`", "",
      "💬 *Conversaciones WhatsApp:*",
      "  • `historial [nombre o número]`",
      "  • `qué habló [nombre]`",
      "  • `resumen de [nombre]` o `dame el resumen de [nombre]`",
      "  • `fotos de [nombre]`",
      "  • `buscar [palabra clave]`", "",
      "🎙️ *Por audio podés decir:*",
      "  • \"dame el resumen de Teresita\"",
      "  • \"cómo va Juan Pérez\"",
      "  • \"gasto de cincuenta mil en materiales\"",
      "  • \"ingreso de cien mil por la visita\"",
    ].join("\n");

  } catch (err) {
    console.error("❌ Memoria: error procesando consulta:", err.message);
    return `❌ Error al buscar en memoria: ${err.message}`;
  }
}

// ── Registrar nombre inmediatamente al detectarlo ─────────────────────────────
async function actualizarNombreInmediato(phone, nombre, { proyecto = "", zona = "", visitaAgendada = false } = {}) {
  if (!nombre || !nombre.trim()) return;
  if (_nombreCache[phone] === nombre) return;

  try {
    const sheetId = await getOrCreateSheetId();
    const sheets  = await getSheetsClient();
    const now     = new Date().toISOString();

    const res  = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "CLIENTES!A:H" });
    const rows = res.data.values || [];
    const idx  = rows.findIndex((r, i) => i > 0 && r[0] === phone);

    if (idx === -1) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: "CLIENTES!A:H",
        valueInputOption: "RAW",
        requestBody: {
          values: [[phone, nombre, proyecto, zona, now, now, "0", visitaAgendada ? "Sí" : "No"]],
        },
      });
    } else {
      const prev   = rows[idx];
      const rowNum = idx + 1;
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `CLIENTES!A${rowNum}:H${rowNum}`,
        valueInputOption: "RAW",
        requestBody: {
          values: [[
            phone,
            nombre,
            proyecto || prev[2] || "",
            zona     || prev[3] || "",
            prev[4]  || now,
            prev[5]  || now,
            prev[6]  || "0",
            visitaAgendada ? "Sí" : (prev[7] || "No"),
          ]],
        },
      });
    }

    _nombreCache[phone] = nombre;
    await rellenarNombresAnteriores(sheetId, sheets, phone, nombre);
    console.log(`✅ Memoria: nombre "${nombre}" registrado inmediatamente para ${phone}`);
  } catch (err) {
    console.error("❌ Memoria: error en actualizarNombreInmediato:", err.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function normalizar(str) {
  return (str || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  // Persistencia
  guardarMensaje,
  guardarMedia,
  actualizarNombreInmediato,

  // Búsquedas
  buscarPorTelefono,
  buscarPorNombre,
  buscarPorContenido,
  listarClientes,
  listarClientesCRM,
  buscarClienteEnCRM,
  obtenerFotos,

  // Formateadores
  formatearMensajes,

  // Memoria (consultas de Darwin)
  esConsultaMemoria,
  procesarConsultaMemoria,

  // NUEVO: Audio/Voz
  detectarComandoVoz,
  parsearMontoEspanol,
};
