/**
 * crm.js — CRM automático en Google Sheets
 * Registra leads y visitas desde Sasha en tiempo real.
 *
 * Estructura de la hoja:
 * Sheet1: "Leads"   → cada contacto nuevo
 * Sheet2: "Visitas" → cada visita agendada
 */

const { google } = require("googleapis");

const SPREADSHEET_ID = "1g43AmJTd3_bu2Hp4wrUSZM8-Irq-KQdvdP3pvNY7Uns";

const HEADERS_LEADS = [
  "Fecha", "Teléfono", "Nombre", "Proyecto", "Zona", "Estado", "Notas"
];

const HEADERS_VISITAS = [
  "Fecha registro", "Fecha visita", "Hora", "Teléfono", "Nombre",
  "Proyecto", "Zona", "Ubicación", "Email", "Estado"
];

// ── Auth ──────────────────────────────────────────────────────────────────────
async function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

// ── Inicializar hojas si no existen ───────────────────────────────────────────
async function initSheets() {
  const sheets = await getSheetsClient();

  // Obtener hojas existentes
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existingSheets = meta.data.sheets.map(s => s.properties.title);

  const requests = [];

  if (!existingSheets.includes("Leads")) {
    requests.push({ addSheet: { properties: { title: "Leads" } } });
  }
  if (!existingSheets.includes("Visitas")) {
    requests.push({ addSheet: { properties: { title: "Visitas" } } });
  }

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: { requests },
    });
    console.log("✅ Hojas CRM creadas");
  }

  // Escribir headers si las hojas están vacías
  await ensureHeaders(sheets, "Leads", HEADERS_LEADS);
  await ensureHeaders(sheets, "Visitas", HEADERS_VISITAS);
}

async function ensureHeaders(sheets, sheetName, headers) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A1:Z1`,
  });

  if (!res.data.values || res.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1`,
      valueInputOption: "RAW",
      resource: { values: [headers] },
    });

    // Formato de headers: negrita + fondo
    const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheet = sheetMeta.data.sheets.find(s => s.properties.title === sheetName);
    if (sheet) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          requests: [
            {
              repeatCell: {
                range: {
                  sheetId: sheet.properties.sheetId,
                  startRowIndex: 0,
                  endRowIndex: 1,
                },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: { red: 0.12, green: 0.12, blue: 0.12 },
                    textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                  },
                },
                fields: "userEnteredFormat(backgroundColor,textFormat)",
              },
            },
          ],
        },
      });
    }
    console.log(`✅ Headers escritos en hoja "${sheetName}"`);
  }
}

// ── Buscar si ya existe un lead por teléfono ──────────────────────────────────
async function findLeadRow(sheets, phone) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Leads!A:B",
  });
  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][1] === phone) return i + 1; // fila en sheets (1-indexed)
  }
  return null;
}

// ── Registrar o actualizar un lead ────────────────────────────────────────────
async function upsertLead(session) {
  try {
    const sheets = await getSheetsClient();
    await initSheets();

    const now = new Date().toLocaleDateString("es-CR", {
      timeZone: "America/Costa_Rica",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });

    const phone = session.phone || "—";
    const row = [
      now,
      phone,
      session.name || "—",
      session.project_desc || "—",
      session.zone || "—",
      session.visit_confirmed ? "Visita agendada" : "Lead nuevo",
      "",
    ];

    const existingRow = await findLeadRow(sheets, phone);

    if (existingRow) {
      // Actualizar fila existente (mantener fecha original, actualizar resto)
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `Leads!B${existingRow}:F${existingRow}`,
        valueInputOption: "RAW",
        resource: {
          values: [[
            phone,
            session.name || "—",
            session.project_desc || "—",
            session.zone || "—",
            session.visit_confirmed ? "Visita agendada" : "Lead activo",
          ]],
        },
      });
      console.log(`✅ CRM: Lead actualizado — ${phone}`);
    } else {
      // Agregar nueva fila
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: "Leads!A:G",
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        resource: { values: [row] },
      });
      console.log(`✅ CRM: Lead nuevo registrado — ${phone}`);
    }
  } catch (err) {
    console.error("❌ CRM upsertLead error:", err.message);
  }
}

// ── Registrar una visita agendada ─────────────────────────────────────────────
async function registerVisit(session) {
  try {
    const sheets = await getSheetsClient();
    await initSheets();

    const now = new Date().toLocaleDateString("es-CR", {
      timeZone: "America/Costa_Rica",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });

    const row = [
      now,
      session.visit_day || "—",
      session.visit_hour || "—",
      session.phone || "—",
      session.name || "—",
      session.project_desc || "—",
      session.zone || "—",
      session.waze_link || "—",
      session.client_email || "—",
      "Agendada",
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "Visitas!A:J",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      resource: { values: [row] },
    });

    console.log(`✅ CRM: Visita registrada — ${session.phone}`);

    // También actualizar el lead
    await upsertLead(session);
  } catch (err) {
    console.error("❌ CRM registerVisit error:", err.message);
  }
}

module.exports = { upsertLead, registerVisit };
