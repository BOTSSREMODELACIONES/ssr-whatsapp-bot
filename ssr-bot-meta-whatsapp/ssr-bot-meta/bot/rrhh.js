/**
 * rrhh.js — Recursos Humanos y Proveedores
 * SS Remodelaciones
 *
 * Guarda solicitantes de empleo y proveedores en:
 *  - Google Drive: carpeta "Solicitantes de trabajo" / "Proveedores"
 *  - Excel en esa carpeta con todos los datos
 */

const { google } = require("googleapis");
const XLSX       = require("xlsx");
const { Readable } = require("stream");

const DARWIN_EMAIL    = "proyectos@ssremodelaciones.com";
const DRIVE_ROOT_RRHH = process.env.RRHH_FOLDER_ID || null; // opcional: carpeta raíz en Drive

// ── Cache de carpetas ─────────────────────────────────────────────────────────
let _folderSolicitantes = null;
let _folderProveedores  = null;
let _sheetSolicitantes  = null;
let _sheetProveedores   = null;

// ── Auth ──────────────────────────────────────────────────────────────────────
async function getAuth() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  return new google.auth.JWT({
    email:   creds.client_email,
    key:     creds.private_key,
    scopes:  ["https://www.googleapis.com/auth/drive"],
    subject: DARWIN_EMAIL,
  });
}

async function getDrive()  { return google.drive({ version: "v3", auth: await getAuth() }); }

// ── Transferir ownership a Darwin ────────────────────────────────────────────
async function transferOwnership(drive, fileId) {
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { role: "owner", type: "user", emailAddress: DARWIN_EMAIL },
      transferOwnership: true,
      moveToNewOwnersRoot: false,
    });
  } catch (e) { console.warn(`⚠️ RRHH: ownership ${fileId}:`, e.message); }
}

// ── Obtener o crear carpeta en Drive ─────────────────────────────────────────
async function getOrCreateFolder(drive, name, parentId = null) {
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentId ? ` and '${parentId}' in parents` : ""}`;
  const search = await drive.files.list({ q, fields: "files(id)", spaces: "drive" });

  if (search.data.files.length > 0) return search.data.files[0].id;

  const body = { name, mimeType: "application/vnd.google-apps.folder" };
  if (parentId) body.parents = [parentId];
  const folder = await drive.files.create({ requestBody: body, fields: "id" });
  await transferOwnership(drive, folder.data.id);
  console.log(`📁 RRHH: carpeta creada "${name}"`);
  return folder.data.id;
}

// ── Obtener o crear Excel (Sheets) en una carpeta ────────────────────────────
async function getOrCreateExcel(drive, folderId, fileName, headers) {
  const q = `name='${fileName}' and '${folderId}' in parents and trashed=false`;
  const search = await drive.files.list({ q, fields: "files(id, webViewLink)", spaces: "drive" });

  if (search.data.files.length > 0) {
    return search.data.files[0];
  }

  // Crear nuevo Excel
  const wb  = XLSX.utils.book_new();
  const ws  = XLSX.utils.aoa_to_sheet([headers]);
  ws["!cols"] = headers.map(() => ({ wch: 20 }));
  XLSX.utils.book_append_sheet(wb, ws, "Datos");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  const file = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: {
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      body: Readable.from(buf),
    },
    fields: "id, webViewLink",
  });
  await transferOwnership(drive, file.data.id);
  console.log(`📊 RRHH: Excel creado "${fileName}"`);
  return file.data;
}

// ── Agregar fila a Excel existente en Drive ───────────────────────────────────
async function appendRowToExcel(drive, fileId, newRow) {
  try {
    // Descargar Excel actual
    const response = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" }
    );
    const wb   = XLSX.read(Buffer.from(response.data), { type: "buffer" });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

    // Agregar nueva fila
    rows.push(newRow);

    // Re-generar Excel
    const wsNew = XLSX.utils.aoa_to_sheet(rows);
    wsNew["!cols"] = rows[0].map(() => ({ wch: 20 }));
    wb.Sheets[wb.SheetNames[0]] = wsNew;
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    // Subir actualizado (patch)
    await drive.files.update({
      fileId,
      media: {
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        body: Readable.from(buf),
      },
    });
    console.log(`✅ RRHH: fila agregada al Excel`);
  } catch (err) {
    console.error("❌ RRHH: error actualizando Excel:", err.message);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOLICITANTES DE TRABAJO
// ═══════════════════════════════════════════════════════════════════════════════

const HEADERS_SOLICITANTE = [
  "FECHA", "TELÉFONO", "NOMBRE", "CÉDULA", "DIRECCIÓN",
  "HABILIDAD", "CURRICULUM", "HOJA_DELINCUENCIA", "ESTADO",
];

/**
 * Guarda un solicitante de empleo en Drive + Excel
 */
async function guardarSolicitante({ phone, nombre, cedula, direccion, habilidad, curriculum }) {
  try {
    const drive = await getDrive();

    // Carpeta principal de RRHH
    if (!_folderSolicitantes) {
      const parent = DRIVE_ROOT_RRHH
        ? await getOrCreateFolder(drive, "RRHH_SSR", DRIVE_ROOT_RRHH)
        : await getOrCreateFolder(drive, "RRHH_SSR");
      _folderSolicitantes = await getOrCreateFolder(drive, "Solicitantes de trabajo", parent);
    }

    // Excel de solicitantes
    if (!_sheetSolicitantes) {
      const excelFile = await getOrCreateExcel(drive, _folderSolicitantes, "Solicitantes_SSR.xlsx", HEADERS_SOLICITANTE);
      _sheetSolicitantes = excelFile.id;
    }

    // Agregar fila
    const fecha = new Date().toLocaleString("es-CR", { timeZone: "America/Costa_Rica" });
    await appendRowToExcel(drive, _sheetSolicitantes, [
      fecha, phone, nombre || "", cedula || "",
      direccion || "", habilidad || "", curriculum || "",
      "Pendiente", "Nuevo",
    ]);

    console.log(`✅ RRHH: solicitante guardado — ${nombre} (${phone})`);
    return true;
  } catch (err) {
    console.error("❌ RRHH: error guardando solicitante:", err.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROVEEDORES
// ═══════════════════════════════════════════════════════════════════════════════

const HEADERS_PROVEEDOR = [
  "FECHA", "TELÉFONO_CONTACTO", "NOMBRE_EMPRESA", "PERSONA_CONTACTO",
  "EMAIL", "TELÉFONO", "SECTOR_NICHO", "NOTAS",
];

/**
 * Guarda un proveedor en Drive + Excel
 */
async function guardarProveedor({ phone, empresa, contacto, email, telefono, sector, notas }) {
  try {
    const drive = await getDrive();

    if (!_folderProveedores) {
      const parent = DRIVE_ROOT_RRHH
        ? await getOrCreateFolder(drive, "RRHH_SSR", DRIVE_ROOT_RRHH)
        : await getOrCreateFolder(drive, "RRHH_SSR");
      _folderProveedores = await getOrCreateFolder(drive, "Proveedores", parent);
    }

    if (!_sheetProveedores) {
      const excelFile = await getOrCreateExcel(drive, _folderProveedores, "Proveedores_SSR.xlsx", HEADERS_PROVEEDOR);
      _sheetProveedores = excelFile.id;
    }

    const fecha = new Date().toLocaleString("es-CR", { timeZone: "America/Costa_Rica" });
    await appendRowToExcel(drive, _sheetProveedores, [
      fecha, phone, empresa || "", contacto || "",
      email || "", telefono || "", sector || "", notas || "",
    ]);

    console.log(`✅ RRHH: proveedor guardado — ${empresa} (${phone})`);
    return true;
  } catch (err) {
    console.error("❌ RRHH: error guardando proveedor:", err.message);
    return false;
  }
}

// ── Helpers para el flujo conversacional ─────────────────────────────────────

/** Pasos del flujo de solicitante */
const PASOS_SOLICITANTE = [
  { campo: "nombre",    pregunta: "¿Cuál es su nombre completo?" },
  { campo: "cedula",    pregunta: "¿Cuál es su número de cédula?" },
  { campo: "telefono",  pregunta: "¿Cuál es su número de teléfono de contacto?" },
  { campo: "direccion", pregunta: "¿Cuál es su dirección de residencia?" },
  { campo: "habilidad", pregunta: "¿Qué habilidad o cargo desempeña? (soldador, ayudante, operario, ingeniero, arquitecto, estudiante u otro)" },
  { campo: "curriculum",pregunta: "Por favor resuma brevemente su experiencia laboral (puede ser corto, solo lo más relevante)." },
];

/** Pasos del flujo de proveedor */
const PASOS_PROVEEDOR = [
  { campo: "empresa",  pregunta: "¿Cuál es el nombre de su empresa o negocio?" },
  { campo: "contacto", pregunta: "¿Cuál es el nombre de la persona de contacto?" },
  { campo: "email",    pregunta: "¿Cuál es el correo electrónico de contacto?" },
  { campo: "telefono", pregunta: "¿Cuál es el teléfono directo de contacto?" },
  { campo: "sector",   pregunta: "¿En qué sector o nicho trabajan? (materiales de construcción, herramientas, servicios, etc.)" },
];

module.exports = {
  guardarSolicitante,
  guardarProveedor,
  PASOS_SOLICITANTE,
  PASOS_PROVEEDOR,
};
