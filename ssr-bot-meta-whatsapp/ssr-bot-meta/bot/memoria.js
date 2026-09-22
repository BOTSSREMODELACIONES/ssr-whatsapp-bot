/**
 * memoria.js — Sistema de Memoria Persistente para Sasha
 * SSR Remodelaciones
 *
 * COLUMNAS MENSAJES (A:J):
 *   A = Fecha y Hora
 *   B = Número de Teléfono
 *   C = Nombre de Contacto
 *   D = Entrada / Salida  (in / out)
 *   E = Tipo              (text / image / audio / document / video)
 *   F = Mensaje
 *   G = mediaId
 *   H = driveUrl
 *   I = Proyecto
 *   J = Zona
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
 * ── CAMBIOS v6 (22 sept 2026) — CAUSA RAÍZ REAL DEL CRM CONGELADO ─────────────
 * El bot SÍ estaba escribiendo, pero desde la fila 2245 (17 sept 19:19) cada
 * fila nueva de MENSAJES caía DESPLAZADA a las columnas I:R en vez de A:J.
 * El CRM lee el teléfono de la columna B; al estar vacía, descarta la fila
 * (isValidPhone) → para el CRM no había mensajes nuevos.
 *
 * POR QUÉ: values.append() no escribe "al final de la hoja", sino al final
 * de la "tabla" que Google DETECTA dentro del rango. La fila 2244 fue la
 * primera con Proyecto/Zona en I:J (cambio v4 de A:F → A:J). Google tomó
 * ese bloque I:J como el borde de la tabla y desde ahí anexó cada fila
 * nueva a partir de la columna I. CLIENTES sufría lo mismo desde mayo
 * (filas en E:L, una fila por mensaje, sin encabezado).
 *
 * FIX:
 *   a) Toda escritura nueva usa appendCells (batchUpdate) con el ID de la
 *      pestaña: SIEMPRE empieza en la columna A, sin detección de tabla.
 *   b) REPARACIÓN AUTOMÁTICA al arrancar (idempotente, se puede correr
 *      siempre): mueve las filas desplazadas de I:R a A:J, corrige el
 *      encabezado de MENSAJES y reconstruye CLIENTES (una fila por
 *      teléfono) a partir de MENSAJES. Log: "🔧 MEMORIA".
 *
 * ── CAMBIOS v5 (22 sept 2026) — CRM CONGELADO DESDE EL 17 SEPT ────────────────
 * SÍNTOMA: Sasha responde normal a los clientes, pero el CRM
 *   (sasha-crm-ssr.netlify.app) no muestra ningún mensaje nuevo desde el
 *   17 de septiembre. El CRM solo lee el CSV publicado de MENSAJES, así que
 *   las filas nuevas o no se están escribiendo, o se están escribiendo en
 *   OTRO spreadsheet que no es el publicado.
 *
 * CAUSAS EN EL CÓDIGO (las tres existían en v4):
 *   1) getOrCreateSheetId() buscaba el sheet por NOMBRE ("SSR_Memoria_Chats")
 *      sin supportsAllDrives / includeItemsFromAllDrives. Si el archivo se
 *      movió a una Unidad Compartida (la solución de v3 para el driveUrl),
 *      la búsqueda deja de verlo. Si hay dos archivos con ese nombre, toma
 *      cualquiera de los dos sin avisar.
 *   2) Si la búsqueda no encontraba nada, CREABA un spreadsheet nuevo: o
 *      falla por la cuota del service account (y entonces TODA escritura
 *      falla) o escribe en un archivo nuevo que el CRM no lee. En ambos
 *      casos Sasha sigue respondiendo y el CRM se congela.
 *   3) guardarMensaje() se tragaba el error en una sola línea de log sin
 *      el detalle de Google, y todos los llamadores usan .catch(() => {}).
 *
 * FIX:
 *   a) MEMORY_SHEET_ID (Railway) es la fuente de verdad. Si no está, la
 *      búsqueda por nombre incluye Unidades Compartidas, ordena por fecha de
 *      creación, usa el ORIGINAL (el más antiguo) y avisa en rojo si hay
 *      duplicados.
 *   b) Ya NO se crea un spreadsheet nuevo en silencio: si no se encuentra,
 *      el error dice exactamente qué configurar.
 *   c) Errores de Google se loguean completos (código + motivo).
 *   d) Si MENSAJES tiene menos de 10 columnas, se amplía y se reintenta.
 *   e) AUTODIAGNÓSTICO al arrancar: loguea en Railway en qué spreadsheet
 *      escribe el bot, el gid de MENSAJES (el CRM lee gid=0), cuántas filas
 *      tiene y la fecha de la última fila. Buscá "🩺 MEMORIA" en los logs.
 * ─────────────────────────────────────────────────────────────────────────────
 * v4 (17 sept 2026): MENSAJES se escribe A:J (mediaId y driveUrl en G/H).
 * v3 (16 sept 2026): supportsAllDrives en subidas a Drive; guardarAdjuntoCliente.
 * v2: fixes de resumen, soporte de audio/voz, parseo de montos en español.
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
const MENSAJES_COLS   = 10; // A:J

let _sheetId = (process.env.MEMORY_SHEET_ID || "").trim() || null;
const _folderCache = {};
const _nombreCache = {};

// ── v5 — Descripción completa de errores de Google ────────────────────────────
function describirErrorGoogle(err) {
  if (!err) return "error desconocido";
  const code    = err.code || err.status || err.response?.status || "";
  const detalle = err.response?.data?.error?.message || err.message || String(err);
  const motivos = (err.errors || err.response?.data?.error?.errors || [])
    .map(e => e.reason).filter(Boolean).join(",");
  return `${code ? `[${code}] ` : ""}${detalle}${motivos ? ` (${motivos})` : ""}`;
}

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

// ── v5 — Localizar el Google Sheet de memoria (sin crear duplicados) ──────────
async function getOrCreateSheetId() {
  if (_sheetId) return _sheetId;

  const drive  = await getDriveClient();
  const search = await drive.files.list({
    q: `name='${SHEET_TITLE}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    fields: "files(id,name,createdTime,modifiedTime,driveId)",
    orderBy: "createdTime",
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "allDrives",
  });

  const files = search.data.files || [];

  if (files.length === 0) {
    // v5: antes acá se creaba un spreadsheet nuevo. Eso deja al CRM leyendo
    // un archivo que el bot ya no usa (o falla por cuota del service
    // account). Ahora se exige configurar el ID explícito.
    throw new Error(
      `No encontré ningún spreadsheet llamado "${SHEET_TITLE}" visible para el service account. ` +
      `Configurá MEMORY_SHEET_ID en Railway con el ID del sheet que publica el CRM ` +
      `(y verificá que esté compartido como Editor con el service account).`
    );
  }

  if (files.length > 1) {
    console.error(
      `🚨 MEMORIA: hay ${files.length} spreadsheets llamados "${SHEET_TITLE}". ` +
      `Uso el MÁS ANTIGUO (${files[0].id}). Definí MEMORY_SHEET_ID en Railway para no depender del nombre:\n` +
      files.map(f => `   • ${f.id} | creado ${f.createdTime} | modificado ${f.modifiedTime}${f.driveId ? " | Unidad Compartida" : ""}`).join("\n")
    );
  }

  _sheetId = files[0].id;
  console.log(`✅ Memoria: sheet encontrado por nombre (${_sheetId}). Recomendado: fijarlo en MEMORY_SHEET_ID.`);
  return _sheetId;
}

// ── v6 — IDs de pestañas + escritura sin detección de tabla ──────────────────
const _tabIds = {};

async function getTabId(sheets, sheetId, title) {
  const key = `${sheetId}:${title}`;
  if (_tabIds[key] !== undefined) return _tabIds[key];
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: "sheets.properties(sheetId,title)",
  });
  for (const s of meta.data.sheets || []) {
    _tabIds[`${sheetId}:${s.properties.title}`] = s.properties.sheetId;
  }
  if (_tabIds[key] === undefined) throw new Error(`El spreadsheet ${sheetId} no tiene una pestaña "${title}"`);
  return _tabIds[key];
}

function aCelda(v) {
  const t = v === null || v === undefined ? "" : String(v);
  return t === "" ? {} : { userEnteredValue: { stringValue: t } };
}

// appendCells agrega la fila después de la última fila con datos de la
// pestaña, SIEMPRE desde la columna A. A diferencia de values.append, no
// intenta adivinar dónde empieza "la tabla", que fue lo que desplazó las
// filas a la columna I.
async function appendFila(sheets, sheetId, title, valores) {
  const tabId = await getTabId(sheets, sheetId, title);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{
        appendCells: {
          sheetId: tabId,
          rows: [{ values: valores.map(aCelda) }],
          fields: "userEnteredValue",
        },
      }],
    },
  });
}

// ── Guardar mensaje en Google Sheets ─────────────────────────────────────────
async function guardarMensaje({ phone, clientName, direction, type, content, mediaId = "", driveUrl = "", session = null }) {
  try {
    if (_reparacion) await _reparacion.catch(() => {});
    const sheetId = await getOrCreateSheetId();
    const sheets  = await getSheetsClient();

    const timestamp = new Date().toISOString();
    const nombre    = clientName || session?.name || "";

    // v4: A:J — mediaId en G, driveUrl en H, proyecto en I, zona en J.
    // La columna F es solo texto legible (sin el enlace incrustado).
    let mensajeCol = content || "";
    if (type === "image" && !mensajeCol) {
      mensajeCol = "[Foto enviada por el cliente]";
    } else if (type === "audio" && !mensajeCol) {
      mensajeCol = "[Audio enviado por el cliente]";
    } else if (type === "document" && !mensajeCol) {
      mensajeCol = "[Documento enviado por el cliente]";
    }

    const proyecto = session?.project_desc || "";
    const zona     = session?.zone || "";

    await appendFila(sheets, sheetId, "MENSAJES", [
      timestamp, phone, nombre, direction, type, mensajeCol,
      mediaId || "", driveUrl || "", proyecto, zona,
    ]);

    if (nombre && nombre.trim() && nombre !== _nombreCache[phone]) {
      _nombreCache[phone] = nombre;
      rellenarNombresAnteriores(sheetId, sheets, phone, nombre)
        .catch(e => console.warn("⚠️ Memoria: error rellenando nombres anteriores:", describirErrorGoogle(e)));
    }

    actualizarCliente(sheetId, sheets, phone, nombre, proyecto, zona, session?.visit_confirmed || false)
      .catch(e => console.warn("⚠️ Memoria: no se actualizó CLIENTES:", describirErrorGoogle(e)));

  } catch (err) {
    // v5: detalle completo — esta línea es la que hay que buscar en Railway
    // si el CRM deja de recibir mensajes.
    console.error(
      `❌ Memoria: NO se guardó mensaje (${direction}/${type}) de ${phone} en sheet ${_sheetId || "(sin resolver)"}:`,
      describirErrorGoogle(err)
    );
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
    console.error("❌ Memoria: error en rellenarNombresAnteriores:", describirErrorGoogle(err));
  }
}

// ── Actualizar resumen de cliente en CLIENTES (A:H) ───────────────────────────
async function actualizarCliente(sheetId, sheets, phone, nombre, proyecto, zona, visitaAgendada) {
  if (_reparacion) await _reparacion.catch(() => {});
  const res  = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "CLIENTES!A:H" });
  const rows = res.data.values || [];
  const now  = new Date().toISOString();

  const idx = rows.findIndex((r, i) => i > 0 && r[0] === phone);

  if (idx === -1) {
    await appendFila(sheets, sheetId, "CLIENTES",
      [phone, nombre, proyecto, zona, now, now, "1", visitaAgendada ? "Sí" : "No"]);
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

// ── v5 — AUTODIAGNÓSTICO (se ejecuta solo al arrancar el bot) ─────────────────
// Deja en los logs de Railway, en líneas que empiezan con "🩺 MEMORIA":
//   • el ID y título del spreadsheet donde escribe el bot
//   • las pestañas con su gid (el CRM lee gid=0)
//   • cantidad de filas de MENSAJES y fecha de la última fila
async function diagnosticoMemoria() {
  const origen = process.env.MEMORY_SHEET_ID ? "MEMORY_SHEET_ID" : "búsqueda por nombre";
  try {
    const sheetId = await getOrCreateSheetId();
    const sheets  = await getSheetsClient();

    const meta = await sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      fields: "properties.title,sheets.properties(sheetId,title,gridProperties)",
    });

    const tabs = (meta.data.sheets || []).map(s => s.properties);
    const tabMensajes = tabs.find(t => t.title === "MENSAJES");

    console.log(`🩺 MEMORIA — spreadsheet: "${meta.data.properties.title}" (${sheetId}) [origen: ${origen}]`);
    console.log(`🩺 MEMORIA — URL: https://docs.google.com/spreadsheets/d/${sheetId}/edit`);
    console.log(`🩺 MEMORIA — pestañas: ${tabs.map(t => `${t.title} (gid=${t.sheetId}, ${t.gridProperties?.rowCount}x${t.gridProperties?.columnCount})`).join(" | ")}`);

    if (!tabMensajes) {
      console.error("🩺 MEMORIA — ❌ No existe la pestaña MENSAJES en este spreadsheet.");
      return;
    }
    if (tabMensajes.sheetId !== 0) {
      console.warn(`🩺 MEMORIA — ⚠️ MENSAJES tiene gid=${tabMensajes.sheetId}, pero el CRM lee gid=0. Revisá el link publicado del CRM.`);
    }

    const colA  = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "MENSAJES!A:A" });
    const filas = colA.data.values || [];
    const ultimaFecha = filas.length > 1 ? filas[filas.length - 1][0] : null;

    console.log(`🩺 MEMORIA — MENSAJES: ${Math.max(0, filas.length - 1)} filas | última: ${ultimaFecha || "—"}`);

    if (ultimaFecha) {
      const horas = (Date.now() - new Date(ultimaFecha).getTime()) / 36e5;
      if (!isNaN(horas) && horas > 24) {
        console.warn(`🩺 MEMORIA — ⚠️ La última fila tiene ${Math.round(horas)} h. Si hubo mensajes desde entonces, este NO es el sheet donde se estaba escribiendo o las escrituras fallaban.`);
      }
    }

    console.log("🩺 MEMORIA — OK: el bot puede leer este spreadsheet. Compará el ID de arriba con el del link publicado del CRM.");
  } catch (err) {
    console.error(`🩺 MEMORIA — ❌ FALLÓ el diagnóstico [origen: ${origen}]:`, describirErrorGoogle(err));
  }
}

// ── v6 — REPARACIÓN AUTOMÁTICA (idempotente) ──────────────────────────────────
const ENCABEZADO_MENSAJES = [
  "Fecha y Hora", "Número de Teléfono", "Nombre de Contacto", "Entrada / Salida",
  "Tipo", "Mensaje", "mediaId", "driveUrl", "Proyecto", "Zona",
];
const ENCABEZADO_CLIENTES = [
  "Teléfono", "Nombre", "Proyecto", "Zona",
  "Primera Actividad", "Última Actividad", "Total Mensajes", "Visita Agendada",
];
const ES_ISO = /^\d{4}-\d{2}-\d{2}T/;

async function repararMemoria() {
  const sheetId = await getOrCreateSheetId();
  const sheets  = await getSheetsClient();

  // ── MENSAJES: filas desplazadas I:R → A:J ────────────────────────────────
  const res  = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "MENSAJES!A:R" });
  const rows = res.data.values || [];
  const data = [];

  const header = rows[0] || [];
  if (ENCABEZADO_MENSAJES.some((h, i) => (header[i] || "") !== h)) {
    data.push({ range: "MENSAJES!A1:J1", values: [ENCABEZADO_MENSAJES] });
  }

  let movidas = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0] && r[8] && ES_ISO.test(String(r[8]))) {
      const nueva = [];
      for (let c = 0; c < 10; c++) nueva.push(r[8 + c] || "");
      for (let c = 10; c < 18; c++) nueva.push("");
      data.push({ range: `MENSAJES!A${i + 1}:R${i + 1}`, values: [nueva] });
      rows[i] = nueva; // para reconstruir CLIENTES con datos ya corregidos
      movidas++;
    }
  }

  for (let k = 0; k < data.length; k += 400) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { valueInputOption: "RAW", data: data.slice(k, k + 400) },
    });
  }
  if (movidas) console.log(`🔧 MEMORIA — ${movidas} filas de MENSAJES movidas de I:R a A:J.`);

  // ── CLIENTES: reconstruir si está corrupto ────────────────────────────────
  const resC  = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "CLIENTES!A:L" });
  const rowsC = resC.data.values || [];
  const cliSano = (rowsC[0]?.[0] || "") === "Teléfono" &&
    rowsC.slice(1).every(r => !r.length || (r[0] && !r[8]));

  if (!cliSano) {
    // Rescatar "Visita Agendada = Sí" de las filas viejas (normales o desplazadas).
    const conVisita = new Set();
    for (const r of rowsC) {
      if (r[0] && r[7] === "Sí") conVisita.add(r[0]);
      if (!r[0] && r[4] && r[11] === "Sí") conVisita.add(r[4]);
    }

    const porTel = new Map();
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const tel = r[1];
      if (!tel || !r[0]) continue;
      const c = porTel.get(tel) || { nombre: "", proyecto: "", zona: "", primera: r[0], ultima: r[0], total: 0 };
      if (r[2]) c.nombre = r[2];
      if (r[8]) c.proyecto = r[8];
      if (r[9]) c.zona = r[9];
      if (r[0] < c.primera) c.primera = r[0];
      if (r[0] > c.ultima)  c.ultima  = r[0];
      c.total++;
      porTel.set(tel, c);
    }

    const valores = [ENCABEZADO_CLIENTES];
    for (const [tel, c] of porTel) {
      valores.push([tel, c.nombre, c.proyecto, c.zona, c.primera, c.ultima, String(c.total), conVisita.has(tel) ? "Sí" : "No"]);
    }

    await sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: "CLIENTES!A:Z" });
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `CLIENTES!A1:H${valores.length}`,
      valueInputOption: "RAW",
      requestBody: { values: valores },
    });
    console.log(`🔧 MEMORIA — CLIENTES reconstruido: ${porTel.size} clientes (antes ${rowsC.length} filas corruptas).`);
  }

  if (!movidas && cliSano) console.log("🔧 MEMORIA — nada que reparar.");
}

let _reparacion = null;

setTimeout(() => {
  _reparacion = repararMemoria()
    .catch(err => console.error("🔧 MEMORIA — ❌ reparación falló:", describirErrorGoogle(err)))
    .finally(() => { _reparacion = null; diagnosticoMemoria().catch(() => {}); });
}, 5000);

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
    console.error("❌ Memoria: error leyendo CRM:", describirErrorGoogle(err));
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
    console.error("❌ Memoria: error buscando en CRM:", describirErrorGoogle(err));
    return [];
  }
}

// ── Guardar media en Drive ────────────────────────────────────────────────────
// v3 — supportsAllDrives:true: requisito para escribir en una Unidad
// Compartida (los service accounts no tienen cuota propia fuera de ellas).
async function guardarMedia(buffer, mimeType, phone, name) {
  try {
    const drive    = await getDriveClient();
    const folderId = await getOrCreateMediaFolder(drive, phone, name);
    const ext      = (mimeType.split("/")[1] || "jpg").replace("jpeg", "jpg").split(";")[0];
    const ts       = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file     = await drive.files.create({
      requestBody: { name: `${phone}_${ts}.${ext}`, parents: [folderId] },
      media: { mimeType, body: Readable.from(buffer) },
      fields: "id, webViewLink",
      supportsAllDrives: true,
    });

    await drive.permissions.create({
      fileId: file.data.id,
      requestBody: { role: "reader", type: "user", emailAddress: DARWIN_EMAIL },
      supportsAllDrives: true,
    }).catch(() => {});

    console.log(`✅ Memoria: archivo guardado → ${file.data.webViewLink}`);
    return file.data.webViewLink;
  } catch (err) {
    // Típico si MEDIA_FOLDER_ID no apunta a una Unidad Compartida:
    // "Service Accounts do not have storage quota".
    console.error("❌ Memoria: error guardando media en Drive:", describirErrorGoogle(err));
    return null;
  }
}

async function getOrCreateMediaFolder(drive, phone, clientName) {
  if (_folderCache[phone]) return _folderCache[phone];
  const safeName   = (clientName || "").replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ\s]/g, "").trim().slice(0, 25);
  const folderName = `Chats_${phone}${safeName ? `_${safeName}` : ""}`;
  const q          = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const search     = await drive.files.list({
    q, fields: "files(id)", spaces: "drive",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: MEDIA_PARENT_ID ? "allDrives" : "user",
  });

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
    supportsAllDrives: true,
  });

  await drive.permissions.create({
    fileId: folder.data.id,
    requestBody: { role: "reader", type: "user", emailAddress: DARWIN_EMAIL },
    supportsAllDrives: true,
  }).catch(() => {});

  _folderCache[phone] = folder.data.id;
  return _folderCache[phone];
}

// ── v3 — Guardar audio/documento (PDF) de un cliente ─────────────────────────
// Descarga el adjunto de WhatsApp, lo sube a Drive y lo registra en MENSAJES
// con su driveUrl. `tipo` es "audio" o "document". Solo para clientes.
async function guardarAdjuntoCliente({ phone, clientName, mediaId, tipo, session = null, contenido = "" }) {
  const { downloadMedia } = require("./messenger");

  const contenidoDefault = tipo === "document"
    ? "[Documento enviado por el cliente]"
    : "[Audio enviado por el cliente]";

  try {
    const { base64, mimeType } = await downloadMedia(mediaId);
    const buffer   = Buffer.from(base64, "base64");
    const driveUrl = await guardarMedia(buffer, mimeType, phone, clientName);

    if (!driveUrl) {
      console.warn(`⚠️ Memoria: ${tipo} de ${phone} (mediaId ${mediaId}) guardado SIN driveUrl — ver el error de guardarMedia arriba en este mismo log.`);
    }

    await guardarMensaje({
      phone, clientName, direction: "in", type: tipo,
      content: contenido || contenidoDefault,
      mediaId, driveUrl: driveUrl || "", session,
    });

  } catch (err) {
    console.error(`❌ Memoria: error guardando adjunto (${tipo}) de ${phone}:`, describirErrorGoogle(err));
    await guardarMensaje({
      phone, clientName, direction: "in", type: tipo,
      content: contenido || contenidoDefault,
      mediaId, driveUrl: "", session,
    }).catch(() => {});
  }
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
 *   "cincuenta mil" → 50000 | "15 mil" → 15000 | "ciento veinte mil" → 120000
 *   "un millon" → 1000000 | "medio millon" → 500000 | "₡50.000" → 50000
 */
function parsearMontoEspanol(texto) {
  // SSR_FIX_20MIL: soporta "20mil", "20 mil", "200mil", "20k", "1.5 millones".
  if (texto !== null && texto !== undefined) {
    const rawTxt = String(texto).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/₡/g, "").trim();
    let m = rawTxt.match(/(\d+(?:[.,]\d+)?)\s*(?:mil|k)\b/);
    if (m) return Math.round(Number(m[1].replace(",", ".")) * 1000);
    m = rawTxt.match(/(\d+(?:[.,]\d+)?)\s*(?:millones?|millon)\b/);
    if (m) return Math.round(Number(m[1].replace(",", ".")) * 1000000);
    m = rawTxt.match(/\d{1,3}(?:[.,]\d{3})+/);
    if (m) return Number(m[0].replace(/[.,]/g, ""));
  }
  if (!texto) return null;

  let t = texto.toLowerCase()
    .replace(/[₡$]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const numPuntos = t.match(/^(\d{1,3}(?:[.,]\d{3})+)$/);
  if (numPuntos) return parseInt(t.replace(/[.,]/g, ""));

  const numSimple = t.match(/^(\d+)$/);
  if (numSimple) return parseInt(t);

  const fracMil = t.match(/^(\d+)[.,](\d+)\s*mil(?:es)?$/);
  if (fracMil) return Math.round(parseFloat(`${fracMil[1]}.${fracMil[2]}`) * 1000);

  const norm = t
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\bde\s+(mil|millon)/g, "$1")
    .replace(/\s+y\s+/g, " ");

  const millonesMatch = norm.match(/^(.+?)\s+millon(?:es)?(.*)$/);
  if (millonesMatch) {
    const baseMillon   = calcularValorPalabras(millonesMatch[1].trim());
    const resto        = millonesMatch[2].trim();
    const restoValor   = resto ? calcularValorPalabras(resto.replace(/^\s*(?:y\s+)?/, "").trim()) : 0;
    if (baseMillon !== null) return (baseMillon === 500 ? 500000 : baseMillon * 1000000) + (restoValor || 0);
  }

  const milesMatch = norm.match(/^(.+?)\s+mil(?:es)?(.*)$/);
  if (milesMatch) {
    const baseMil  = calcularValorPalabras(milesMatch[1].trim());
    const restoMil = milesMatch[2].trim();
    const restoVal = restoMil ? calcularValorPalabras(restoMil.replace(/^\s*(?:y\s+)?/, "").trim()) : 0;
    if (baseMil !== null) return baseMil * 1000 + (restoVal || 0);
  }

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
// Devuelve { tipo, payload } con tipo GASTO | INGRESO | MSG_CLIENTE |
// RESUMEN_CLIENTE, o null si no detecta ningún comando.
// ═══════════════════════════════════════════════════════════════════════════════
function detectarComandoVoz(text) {
  if (!text || !text.trim()) return null;
  const t = text.trim();

  // ── GASTO ──────────────────────────────────────────────────────────────────
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
 */
function _separarMontoDesc(texto) {
  let t = texto
    .replace(/\bcolon(?:es)?\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

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
  /resumen/i,
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
    const resumenPatterns = [
      /res[uú]me(?:n|me|nos?)?\s+(?:de\s+)?(?:la\s+)?conversaci[oó]n\s+(?:de\s+|con\s+)?(.+)/i,
      /(?:dame|deme)\s+(?:el\s+)?resumen\s+(?:de\s+(?:la\s+)?(?:conversaci[oó]n\s+)?(?:de\s+|con\s+)?)?(.+)/i,
      /mu[eé]strame\s+(?:el\s+)?(?:resumen|historial|conversaci[oó]n)\s+(?:de\s+|con\s+)?(.+)/i,
      /(?:d[ií]me|cu[eé]ntame)\s+(?:qu[eé]|c[oó]mo)\s+(?:hab[ló]|fue|anda|est[aá]|va)\s+(?:con\s+)?(.+)/i,
      /qu[eé]\s+pas[oó]\s+(?:con|de)\s+(.+)/i,
      /c[oó]mo\s+(?:va|est[aá]|anda)\s+(?:el\s+|la\s+)?(?:cliente\s+|caso\s+)?(.+)/i,
      /qu[eé]\s+anda\s+(?:pasando\s+)?(?:con\s+)?(.+)/i,
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
    const nombrePatterns = [
      /historial\s+(?:de\s+)?(.+)/i,
      /qu[eé]\s+(?:hab[ló]|dij[oi]|mand[oó]|hablaste|conversaste)\s+(?:con\s+)?(.+)/i,
      /conversaci[oó]n\s+(?:de\s+|con\s+)?(.+)/i,
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
    console.error("❌ Memoria: error procesando consulta:", describirErrorGoogle(err));
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
      await appendFila(sheets, sheetId, "CLIENTES",
        [phone, nombre, proyecto, zona, now, now, "0", visitaAgendada ? "Sí" : "No"]);
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
    console.error("❌ Memoria: error en actualizarNombreInmediato:", describirErrorGoogle(err));
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
  guardarAdjuntoCliente,
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

  // Audio/Voz
  detectarComandoVoz,
  parsearMontoEspanol,

  // v5/v6 — diagnóstico y reparación
  diagnosticoMemoria,
  repararMemoria,
};
