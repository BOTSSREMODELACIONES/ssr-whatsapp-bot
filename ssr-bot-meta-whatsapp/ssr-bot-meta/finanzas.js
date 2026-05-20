// ============================================================
// finanzas.js — Módulo financiero para Sasha (SS Remodelaciones)
// Colocar en: ssr-bot-meta-whatsapp/ssr-bot-meta/bot/finanzas.js
// ============================================================

const Anthropic = require("@anthropic-ai/sdk");

// ─── Config ──────────────────────────────────────────────────────────────────
// URL del Apps Script desplegado como Web App (ver instrucciones abajo)
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || "";

// ID de tu Google Sheets (el de la URL del archivo)
const SHEETS_ID = process.env.SHEETS_ID || "1H8DxPYEIECGQ-UwBz8ex76fam5_OCbS7";

// ─── Proyectos conocidos (sincronizar con tu Sheets periódicamente) ───────────
const PROYECTOS = [
  { codigo: "PROY 001/2026", nombre: "Sergio Gonzales Pauta", alias: ["sergio", "gonzales"] },
  { codigo: "PROY 002/2026", nombre: "Jeannette Mora",        alias: ["jeannette", "jeanette", "cocina"] },
  { codigo: "PROY 021/2026", nombre: "Proyecto 021",          alias: ["021", "proy 021"] },
  { codigo: "PROY 010/2026", nombre: "Obra Residencial",      alias: ["010"] },
];

// ─── Palabras clave que indican que el mensaje ES financiero ─────────────────
const KEYWORDS_FINANZAS = [
  "pagué", "pague", "pago", "pagaron", "me pagaron", "compré", "compre",
  "compra", "compras", "gasté", "gaste", "gasto", "ingreso", "adelanto",
  "factura", "planilla", "sueldo", "salario", "materiales", "herramientas",
  "gasolina", "combustible", "transporte", "almuerzo", "comida", "alimentacion",
  "colones", "mil colones", "millones", "efectivo", "transferencia", "sinpe",
  "epa", "ferretería", "ferreteria", "construplaza", "bodega", "inventario",
  "subcontrato", "subcontratista", "mano de obra", "cuanto se gastó",
  "cuánto", "cuanto", "registrar gasto", "anota", "apunta", "registra",
];

// ─── Sistema de prompts para el agente financiero ────────────────────────────
const TODAY = () => new Date().toLocaleDateString("es-CR", {
  timeZone: "America/Costa_Rica",
  year: "numeric", month: "2-digit", day: "2-digit"
}).split("/").reverse().join("-");

const buildSystemPrompt = () => {
  const proyectosCtx = PROYECTOS
    .map(p => `- ${p.codigo}: ${p.nombre} (alias: ${p.alias.join(", ")})`)
    .join("\n");

  return `Sos el agente financiero IA de SS Remodelaciones, empresa costarricense de construcción.

PROYECTOS ACTIVOS:
${proyectosCtx}

REGLAS:
- "X mil" = X * 1000 colones. "medio millón" = 500000. "un millón" = 1000000
- Fecha: hoy (${TODAY()}) si no se especifica
- Detectá proyecto por alias: "sergio" → PROY 001/2026
- EPA, Ferretería, Construplaza = categoría Materiales
- "planilla", "sueldo", pago a empleado = tipo PLANILLA, pestaña PLANILLAS
- "gimnasio", "supermercado personal", gastos personales = es_personal: true
- "me pagaron", "adelanto", pago de cliente = tipo INGRESO, pestaña INGRESOS_CLIENTES
- "tornillos", "inventario", "para bodega" = tipo INVENTARIO, pestaña INVENTARIO
- Siempre incluir CAJA_GENERAL en pestanas_adicionales (todos los movimientos van ahí)

CATEGORÍAS: Materiales | Mano de obra | Transporte | Gasolina | Herramientas |
Alimentación | Subcontrato | Personal | Oficina | Marketing | Equipo | Impuestos | Caja chica

Respondé SOLO JSON válido sin markdown:
{
  "fecha": "YYYY-MM-DD",
  "monto": 125000,
  "tipo": "GASTO|INGRESO|PLANILLA|INVENTARIO",
  "proyecto": "nombre completo o null",
  "proyecto_codigo": "PROY XXX/YYYY o null",
  "cliente": "nombre o null",
  "categoria": "categoría",
  "descripcion": "3-6 palabras descriptivas",
  "proveedor": "nombre o null",
  "forma_pago": "Efectivo|Transferencia|SINPE|Tarjeta|null",
  "responsable": "nombre o null",
  "es_personal": false,
  "pestaña_principal": "GASTOS_PROYECTO",
  "pestanas_adicionales": ["CAJA_GENERAL"],
  "confianza": 95,
  "observaciones": "alerta importante o null"
}`;
};

// ─── Detectar si el mensaje es financiero ────────────────────────────────────
function esComandoFinanciero(texto) {
  if (!texto) return false;
  const t = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return KEYWORDS_FINANZAS.some(kw =>
    t.includes(kw.normalize("NFD").replace(/[\u0300-\u036f]/g, ""))
  );
}

// ─── Interpretar mensaje con Claude ─────────────────────────────────────────
async function interpretarMovimiento(texto) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 600,
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: texto }],
  });

  const raw = response.content[0]?.text || "{}";
  const clean = raw.replace(/```json\n?|\n?```/g, "").trim();
  return JSON.parse(clean);
}

// ─── Escribir en Google Sheets via Apps Script ───────────────────────────────
async function registrarEnSheets(data) {
  if (!APPS_SCRIPT_URL) {
    console.warn("⚠️ finanzas.js: APPS_SCRIPT_URL no configurado — modo simulación");
    return { success: true, simulated: true };
  }

  const res = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  if (!res.ok) throw new Error(`Apps Script error: ${res.status}`);
  return res.json();
}

// ─── Formatear monto en colones ──────────────────────────────────────────────
function formatCRC(n) {
  return `₡${Number(n).toLocaleString("es-CR")}`;
}

// ─── Generar mensaje de confirmación para WhatsApp ───────────────────────────
function generarConfirmacion(data, resultado) {
  const tipo = {
    GASTO:      { emoji: "💸", label: "Gasto" },
    INGRESO:    { emoji: "💰", label: "Ingreso" },
    PLANILLA:   { emoji: "👷", label: "Planilla" },
    INVENTARIO: { emoji: "📦", label: "Inventario" },
  }[data.tipo] || { emoji: "📋", label: data.tipo };

  const simTag = resultado?.simulated ? "\n⚠️ _Modo simulación — configura APPS_SCRIPT_URL_" : "";

  const lineas = [
    `${tipo.emoji} *${tipo.label} registrado en Sheets*`,
    "",
    `📝 ${data.descripcion}`,
    `💵 *${formatCRC(data.monto)}*`,
  ];

  if (data.proyecto_codigo) lineas.push(`🏗️ ${data.proyecto_codigo}`);
  if (data.proveedor)       lineas.push(`🏪 ${data.proveedor}`);
  if (data.forma_pago)      lineas.push(`💳 ${data.forma_pago}`);
  if (data.es_personal)     lineas.push(`👤 Gasto personal`);

  lineas.push(`📊 Pestaña: *${data.pestaña_principal}*`);

  if (data.pestanas_adicionales?.length) {
    lineas.push(`📋 Copia en: ${data.pestanas_adicionales.join(", ")}`);
  }
  if (data.confianza < 75) {
    lineas.push(`\n⚠️ _Confianza baja (${data.confianza}%) — verificar manualmente_`);
  }
  if (data.observaciones) {
    lineas.push(`\n📌 ${data.observaciones}`);
  }

  lineas.push("", "_Sasha — Agente Financiero SSR_");
  if (simTag) lineas.push(simTag);

  return lineas.join("\n");
}

// ─── Función principal — llamar desde index.js ───────────────────────────────
/**
 * Procesa un mensaje financiero del supervisor.
 * @param {string} texto — Mensaje en lenguaje natural
 * @returns {string|null} — Respuesta formateada para WhatsApp, o null si no es financiero
 */
async function procesarComandoFinanciero(texto) {
  if (!esComandoFinanciero(texto)) return null;

  try {
    // 1. Interpretar con Claude
    const datos = await interpretarMovimiento(texto);

    if (!datos.monto || datos.monto <= 0) {
      return "❌ No pude detectar un monto válido. Intentá ser más específico, ej: _Pagué 25 mil de gasolina para Sergio_.";
    }

    // 2. Registrar en Google Sheets
    const resultado = await registrarEnSheets({
      ...datos,
      audit_id: `SSR-${Date.now()}`,
      canal: "whatsapp",
    });

    // 3. Responder confirmación
    return generarConfirmacion(datos, resultado);

  } catch (err) {
    console.error("❌ finanzas.js error:", err.message);
    // No romper el flujo de Sasha — retornar null para que siga con el flujo normal
    return null;
  }
}

module.exports = { procesarComandoFinanciero, esComandoFinanciero };
