// ============================================================
// finanzas.js — Módulo financiero para Sasha (SS Remodelaciones)
// Ubicación: ssr-bot-meta-whatsapp/ssr-bot-meta/bot/finanzas.js
// ============================================================

const Anthropic = require("@anthropic-ai/sdk");

// ─── Config ──────────────────────────────────────────────────
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL ||
  "https://script.google.com/macros/s/AKfycbxpOjoxmar3WsfqwFS1EXJN4uYApUtXph08NSt_q35_6QIX-IP0SuFEqNFqhExRKIvx/exec";

// ⚠️ ID ACTUALIZADO — archivo Google Sheets nativo (no xlsx)
const SHEETS_ID = process.env.SHEETS_ID ||
  "1txCpYo8h30i_GW-aa0M59AwsukgRr3rjlKbgRguz9eA";

// ─── Proyectos SSR — activos Y cerrados ──────────────────────
// Incluir TODOS los proyectos, sin importar su estado.
// Los proyectos cerrados pueden recibir gastos de garantía o reparación.
const PROYECTOS = [
  // 2026
  { codigo: "PROY 001/2026", nombre: "Sergio Gonzales Pauta",   alias: ["sergio", "gonzales", "gonzalez"] },
  { codigo: "PROY 002/2026", nombre: "Jeannette Mora",          alias: ["jeannette", "jeanette"] },
  { codigo: "PROY 003/2026", nombre: "Proyecto 003",            alias: ["003"] },
  { codigo: "PROY 016/2026", nombre: "Guillermo",               alias: ["guillermo"] },
  { codigo: "PROY 019/2026", nombre: "Cristián",                alias: ["cristian", "cristián"] },
  { codigo: "PROY 021/2026", nombre: "Proyecto 021",            alias: ["021"] },
  { codigo: "PROY 028/2026", nombre: "Proyecto 028",            alias: ["028"] },
  { codigo: "PROY 033/2026", nombre: "Proyecto 033",            alias: ["033"] },
  { codigo: "PROY 043/2026", nombre: "Proyecto Miriam",         alias: ["miriam"] },
  // 2025 (cerrados — pueden recibir gastos de garantía)
  { codigo: "PROY 001/2025", nombre: "Fede",                    alias: ["fede", "federico"] },
  { codigo: "PROY 002/2025", nombre: "Cesar Adrián",            alias: ["cesar", "adrian", "césar"] },
  { codigo: "PROY 003/2025", nombre: "Gustavo",                 alias: ["gustavo"] },
  { codigo: "PROY 004/2025", nombre: "Franxi Solano",           alias: ["franxi", "solano"] },
  { codigo: "PROY 008/2025", nombre: "Jorge Córdoba",           alias: ["jorge", "cordoba", "córdoba"] },
  { codigo: "PROY 010/2025", nombre: "Anahi",                   alias: ["anahi", "anahí"] },
  { codigo: "PROY 013/2025", nombre: "Miriam",                  alias: ["miriam 2025"] },
  { codigo: "PROY 015/2025", nombre: "Fede y Lore",             alias: ["lore", "fede y lore"] },
  { codigo: "PROY 017/2025", nombre: "Jeannette 2025",          alias: ["jeannette 2025"] },
  { codigo: "PROY 022/2025", nombre: "Nathalie",                alias: ["nathalie", "natalie"] },
];

// ─── Palabras clave para detectar mensajes financieros ───────
const KEYWORDS_FINANZAS = [
  // Verbos de registro
  "pagué", "pague", "pago", "pagaron", "me pagaron",
  "compré", "compre", "compra", "compras",
  "gasté", "gaste", "gasto", "gastos",
  "carga", "cargá", "cargame", "cárgame", "cargalo", "cárgalo",
  "cargar", "registra", "registrame", "registrá", "anota", "apunta",
  "cobré", "cobre", "cobré", "facturé", "facture",
  // Tipos de movimiento
  "ingreso", "adelanto", "abono", "depósito", "deposito",
  "planilla", "sueldo", "salario", "quincena",
  "subcontrato", "subcontratista",
  // Categorías comunes
  "materiales", "herramientas", "gasolina", "combustible",
  "transporte", "flete", "almuerzo", "comida", "alimentacion",
  "ferretería", "ferreteria", "epa", "construplaza",
  "bodega", "inventario", "repuesto", "tornillos",
  "mano de obra", "jornal",
  // Indicadores de monto
  "colones", "mil colones", "millones",
  "efectivo", "transferencia", "sinpe", "tarjeta",
];

// ─── Fecha de hoy en Costa Rica ──────────────────────────────
const TODAY = () => {
  const cr = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Costa_Rica" }));
  return cr.getFullYear() + "-"
    + String(cr.getMonth() + 1).padStart(2, "0") + "-"
    + String(cr.getDate()).padStart(2, "0");
};

// ─── System prompt del agente financiero ─────────────────────
const buildSystemPrompt = () => {
  const proyectosCtx = PROYECTOS
    .map(p => `- ${p.codigo}: ${p.nombre}`)
    .join("\n");

  return `Sos el agente financiero IA de SS Remodelaciones, empresa costarricense de construcción y remodelación.

PROYECTOS SSR (activos y cerrados — ambos válidos para recibir gastos):
${proyectosCtx}

REGLAS DE INTERPRETACIÓN:
- "X mil" = X * 1000 colones. "medio millón" = 500000
- Sin fecha = hoy: ${TODAY()}
- Detectá proyecto por nombre parcial: "sergio" → PROY 001/2026, "fede" → PROY 001/2025
- Los proyectos CERRADOS también pueden recibir gastos (garantías, reparaciones, retoques)
- EPA, Ferretería, Construplaza, Cemex = categoría "Materiales"
- Gasolina, combustible, diésel = categoría "Gasolina"
- "planilla", "sueldo", pago a trabajador = tipo PLANILLA
- "me pagaron", "adelanto", "abono de cliente" = tipo INGRESO
- "inventario", "bodega", "para stock" = tipo INVENTARIO
- "gimnasio", "supermercado personal", gastos no relacionados a SSR = es_personal: true
- "SSR", "pick up", "vehículo", sin proyecto específico = proyecto null, proyecto_codigo null
- SIEMPRE incluir "CAJA_GENERAL" en pestanas_adicionales

CATEGORÍAS VÁLIDAS:
Materiales | Mano de obra | Transporte | Gasolina | Herramientas | Alimentación |
Subcontrato | Personal | Oficina | Marketing | Equipo | Impuestos | Caja chica | Garantía

PESTAÑAS — USA ÚNICAMENTE ESTOS NOMBRES EXACTOS, NUNCA OTROS:
- "GASTOS_PROYECTO" → cualquier gasto (con o sin proyecto, activo o cerrado)
- "INGRESOS_CLIENTES" → pago o adelanto recibido de un cliente
- "BASE_PLANILLA" → pago a empleado, planilla, sueldo, jornal
- "INVENTARIO" → compra para bodega o stock general
- "SUBCONTRATOS" → pago a subcontratista externo

PROHIBIDO: nunca uses "GASTOS_GENERALES", "GASTOS_SSR", "CAJA_CHICA" ni ningún nombre inventado.
Si el gasto no tiene proyecto, igual usa "GASTOS_PROYECTO" y deja proyecto_codigo en null.

Respondé ÚNICAMENTE con JSON válido, sin markdown, sin explicación:
{
  "fecha": "YYYY-MM-DD",
  "monto": 15000,
  "tipo": "GASTO",
  "proyecto": "nombre del proyecto o null",
  "proyecto_codigo": "PROY XXX/YYYY o null",
  "cliente": "nombre del cliente o null",
  "categoria": "Gasolina",
  "descripcion": "3-6 palabras descriptivas",
  "proveedor": "nombre o null",
  "forma_pago": "Efectivo|Transferencia|SINPE|Tarjeta|null",
  "responsable": "nombre o null",
  "es_personal": false,
  "pestaña_principal": "GASTOS_PROYECTO",
  "pestanas_adicionales": ["CAJA_GENERAL"],
  "confianza": 95,
  "observaciones": "nota importante o null"
}`;
};

// ─── Detectar si el mensaje es financiero ────────────────────
function esComandoFinanciero(texto) {
  if (!texto) return false;
  const t = texto.toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return KEYWORDS_FINANZAS.some(kw =>
    t.includes(kw.normalize("NFD").replace(/[\u0300-\u036f]/g, ""))
  );
}

// ─── Interpretar con Claude ───────────────────────────────────
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

// ─── Enviar a Google Sheets via Apps Script ───────────────────
async function registrarEnSheets(data) {
  if (!APPS_SCRIPT_URL) {
    console.warn("⚠️ APPS_SCRIPT_URL no configurado — modo simulación");
    return { success: true, simulated: true };
  }
  const res = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Apps Script HTTP ${res.status}`);
  return res.json();
}

// ─── Formatear colones ────────────────────────────────────────
function formatCRC(n) {
  return `₡${Number(n).toLocaleString("es-CR")}`;
}

// ─── Mensaje de confirmación para WhatsApp ────────────────────
function generarConfirmacion(data, resultado) {
  const tipos = {
    GASTO:      { emoji: "💸", label: "Gasto registrado" },
    INGRESO:    { emoji: "💰", label: "Ingreso registrado" },
    PLANILLA:   { emoji: "👷", label: "Planilla registrada" },
    INVENTARIO: { emoji: "📦", label: "Inventario registrado" },
  };
  const cfg = tipos[data.tipo] || { emoji: "📋", label: "Movimiento registrado" };

  const lineas = [
    `${cfg.emoji} *${cfg.label} en Sheets*`,
    "",
    `📝 ${data.descripcion}`,
    `💵 *${formatCRC(data.monto)}*`,
  ];

  if (data.proyecto_codigo) lineas.push(`🏗️ ${data.proyecto_codigo}`);
  if (data.proveedor)        lineas.push(`🏪 ${data.proveedor}`);
  if (data.forma_pago)       lineas.push(`💳 ${data.forma_pago}`);
  if (data.es_personal)      lineas.push(`👤 Gasto personal`);

  lineas.push(`📊 Pestaña: *${data.pestaña_principal}*`);

  if (data.pestanas_adicionales?.length) {
    lineas.push(`📋 Copia en: ${data.pestanas_adicionales.join(", ")}`);
  }
  if (data.confianza < 75) {
    lineas.push(`\n⚠️ _Confianza baja (${data.confianza}%) — verificar_`);
  }
  if (data.observaciones) {
    lineas.push(`\n📌 ${data.observaciones}`);
  }
  if (resultado?.simulated) {
    lineas.push(`\n⚠️ _Modo simulación — revisar APPS_SCRIPT_URL_`);
  }

  lineas.push("", "_Sasha — Agente Financiero SSR_");
  return lineas.join("\n");
}

// ─── Función principal ────────────────────────────────────────
async function procesarComandoFinanciero(texto) {
  if (!esComandoFinanciero(texto)) return null;

  try {
    // 1. Claude interpreta el mensaje
    const datos = await interpretarMovimiento(texto);

    if (!datos.monto || datos.monto <= 0) {
      return "❌ No pude detectar un monto válido.\nEjemplo: _Pagué 25 mil de gasolina para Sergio_";
    }

    // 2. Registrar en Google Sheets
    const resultado = await registrarEnSheets({
      ...datos,
      audit_id: `SSR-${Date.now()}`,
      canal: "whatsapp",
    });

    // 3. Si es duplicado, avisar
    if (resultado?.resultado?.status === "DUPLICADO") {
      return `⚠️ *Posible duplicado*\n\nYa existe un movimiento similar registrado en las últimas 24 horas.\n📝 ${datos.descripcion} — ${formatCRC(datos.monto)}\n\nSi es correcto igual, respondé *confirmar* para forzar el registro.`;
    }

    // 4. Confirmar registro exitoso
    return generarConfirmacion(datos, resultado);

  } catch (err) {
    console.error("❌ finanzas.js error:", err.message);
    return null;
  }
}

module.exports = { procesarComandoFinanciero, esComandoFinanciero };
