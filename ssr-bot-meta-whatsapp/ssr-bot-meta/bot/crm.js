/**
 * crm.js — CRM automático en Google Sheets
 * Escribe en la planilla CRM_Sasha_SSR con 3 hojas:
 *   - "CRM Clientes" → una fila por cliente, se actualiza conforme avanza
 *   - "Visitas"      → una fila por cada visita agendada
 *   - "Dashboard"    → fórmulas automáticas, no se toca desde aquí
 */

const { google } = require("googleapis");

const SPREADSHEET_ID = "1ml93G-Mi92MhauD3PhooL5_k51XxxWSa";

const COL = {
  FECHA_REGISTRO:   1,
  TELEFONO:         2,
  NOMBRE:           3,
  EMAIL:            4,
  UBICACION:        5,
  ZONA:             6,
  PROYECTO:         7,
  FECHA_VISITA:     8,
  HORA_VISITA:      9,
  ESTADO:           10,
  VISITA_REALIZADA: 11,
  COT_ENVIADA:      12,
  MONTO_COTIZADO:   13,
  MONTO_CONTRATADO: 14,
  EXTRAS:           15,
  TOTAL:            16,
  FECHA_ULT_CONT:   17,
  RESPONSABLE:      18,
  NOTAS:            19,
};

async function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

function nowCR() {
  return new Date().toLocaleString("es-CR", {
    timeZone: "America/Costa_Rica",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

async function findClientRow(sheets, phone) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "'CRM Clientes'!B3:B500",
    });
    const rows = res.data.values || [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === phone || rows[i][0] === phone.replace("+", "")) {
        return i + 3;
      }
    }
  } catch (err) {
    console.error("❌ CRM findClientRow error:", err.message);
  }
  return null;
}

async function upsertLead(session) {
  try {
    const sheets = await getSheetsClient();
    const phone = session.phone || "—";
    const existingRow = await findClientRow(sheets, phone);

    if (existingRow) {
      const updates = [
        { col: COL.NOMBRE,      val: session.name || "—" },
        { col: COL.EMAIL,       val: session.client_email || "—" },
        { col: COL.ZONA,        val: session.zone || "—" },
        { col: COL.PROYECTO,    val: session.project_desc || "—" },
        { col: COL.RESPONSABLE, val: "Melvin Zúñiga" },
      ];
      if (session.visit_confirmed) {
        updates.push({ col: COL.ESTADO, val: "Visita agendada" });
      }
      for (const { col, val } of updates) {
        const colLetter = String.fromCharCode(64 + col);
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `'CRM Clientes'!${colLetter}${existingRow}`,
          valueInputOption: "USER_ENTERED",
          resource: { values: [[val]] },
        });
      }
      console.log(`✅ CRM: Lead actualizado — fila ${existingRow} (${phone})`);
    } else {
      const row = Array(19).fill("");
      row[COL.FECHA_REGISTRO - 1] = nowCR();
      row[COL.TELEFONO - 1]       = phone;
      row[COL.NOMBRE - 1]         = session.name || "—";
      row[COL.EMAIL - 1]          = session.client_email || "—";
      row[COL.UBICACION - 1]      = session.waze_link || "—";
      row[COL.ZONA - 1]           = session.zone || "—";
      row[COL.PROYECTO - 1]       = session.project_desc || "—";
      row[COL.ESTADO - 1]         = session.visit_confirmed ? "Visita agendada" : "Nuevo";
      row[COL.RESPONSABLE - 1]    = "Melvin Zúñiga";

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: "'CRM Clientes'!A3",
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        resource: { values: [row] },
      });
      console.log(`✅ CRM: Lead nuevo registrado — ${phone}`);
    }
  } catch (err) {
    console.error("❌ CRM upsertLead error:", err.message);
  }
}

async function registerVisit(session) {
  try {
    const sheets = await getSheetsClient();
    const phone = session.phone || "—";

    const updates = [
      { col: COL.NOMBRE,       val: session.name || "—" },
      { col: COL.EMAIL,        val: session.client_email || "—" },
      { col: COL.UBICACION,    val: session.waze_link || "—" },
      { col: COL.ZONA,         val: session.zone || "—" },
      { col: COL.PROYECTO,     val: session.project_desc || "—" },
      { col: COL.FECHA_VISITA, val: session.visit_day || "—" },
      { col: COL.HORA_VISITA,  val: session.visit_hour || "—" },
      { col: COL.ESTADO,       val: "Visita agendada" },
      { col: COL.RESPONSABLE,  val: "Melvin Zúñiga" },
    ];

    const existingRow = await findClientRow(sheets, phone);

    if (existingRow) {
      for (const { col, val } of updates) {
        const colLetter = String.fromCharCode(64 + col);
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `'CRM Clientes'!${colLetter}${existingRow}`,
          valueInputOption: "USER_ENTERED",
          resource: { values: [[val]] },
        });
      }
      console.log(`✅ CRM: Visita actualizada en fila ${existingRow}`);
    } else {
      const row = Array(19).fill("");
      row[COL.FECHA_REGISTRO - 1] = nowCR();
      row[COL.TELEFONO - 1]       = phone;
      row[COL.NOMBRE - 1]         = session.name || "—";
      row[COL.EMAIL - 1]          = session.client_email || "—";
      row[COL.UBICACION - 1]      = session.waze_link || "—";
      row[COL.ZONA - 1]           = session.zone || "—";
      row[COL.PROYECTO - 1]       = session.project_desc || "—";
      row[COL.FECHA_VISITA - 1]   = session.visit_day || "—";
      row[COL.HORA_VISITA - 1]    = session.visit_hour || "—";
      row[COL.ESTADO - 1]         = "Visita agendada";
      row[COL.RESPONSABLE - 1]    = "Melvin Zúñiga";

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: "'CRM Clientes'!A3",
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        resource: { values: [row] },
      });
      console.log(`✅ CRM: Fila nueva con visita — ${phone}`);
    }

    // Registrar en hoja Visitas
    const visitRow = [
      nowCR(),
      session.visit_day || "—",
      session.visit_hour || "—",
      phone,
      session.name || "—",
      session.project_desc || "—",
      session.zone || "—",
      session.waze_link || "—",
      session.client_email || "—",
      "Agendada",
      "",
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "'Visitas'!A3",
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      resource: { values: [visitRow] },
    });
    console.log(`✅ CRM: Visita registrada en hoja Visitas — ${phone}`);

  } catch (err) {
    console.error("❌ CRM registerVisit error:", err.message);
  }
}

module.exports = { upsertLead, registerVisit };
