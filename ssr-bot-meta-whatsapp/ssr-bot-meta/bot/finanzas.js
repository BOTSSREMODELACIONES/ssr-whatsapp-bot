// ============================================================
// finanzas.js — Módulo financiero para Sasha (SS Remodelaciones)
// Ubicación: ssr-bot-meta-whatsapp/ssr-bot-meta/bot/finanzas.js
// ============================================================

const Anthropic = require("@anthropic-ai/sdk");

// ─── Config ──────────────────────────────────────────────────
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL ||
  "https://script.google.com/macros/s/AKfycbxpOjoxmar3WsfqwFS1EXJN4uYApUtXph08NSt_q35_6QIX-IP0SuFEqNFqhExRKIvx/exec";

const SHEETS_ID = process.env.SHEETS_ID ||
  "1txCpYo8h30i_GW-aa0M59AwsukgRr3rjlKbgRguz9eA";

// ─── Proyectos SSR — activos Y cerrados ──────────────────────
const PROYECTOS = [
  // 2026 activos
  { codigo: "PROY 001/2026", nombre: "Sergio Gonzales Pauta",  alias: ["sergio", "gonzales", "gonzalez"] },
  { codigo: "PROY 002/2026", nombre: "Jeannette Mora",         alias: ["jeannette", "jeanette"] },
  { codigo: "PROY 003/2026", nombre: "Proyecto 003",           alias: ["003"] },
  { codigo: "PROY 016/2026", nombre: "Guillermo",              alias: ["guillermo"] },
  { codigo: "PROY 028/2026", nombre: "Fede",                   alias: ["fede", "federico"] },
  { codigo: "PROY 019/2026", nombre: "Cristián",               alias: ["cristian", "cristián"] },
  { codigo: "PROY 021/2026", nombre: "Proyecto 021",           alias: ["021"] },
  { codigo: "PROY 028/2026", nombre: "Proyecto 028",           alias: ["028"] },
  { codigo: "PROY 033/2026", nombre: "Proyecto 033",           alias: ["033"] },
  { codigo: "PROY 043/2026", nombre: "Miriam",                 alias: ["miriam"] },
  // 2025 cerrados — válidos para garantías y reparaciones
  { codigo: "PROY 001/2025", nombre: "César Adrián",           alias: ["cesar", "adrian", "césar"] },
  { codigo: "PROY 003/2025", nombre: "Gustavo",                alias: ["gustavo"] },
  { codigo: "PROY 004/2025", nombre: "Franxi Solano",          alias: ["franxi", "solano"] },
  { codigo: "PROY 008/2025", nombre: "Jorge Córdoba",          alias: ["jorge", "cordoba", "córdoba"] },
  { codigo: "PROY 010/2025", nombre: "Anahi",                  alias: ["anahi", "anahí"] },
  { codigo: "PROY 015/2025", nombre: "Fede y Lore",            alias: ["lore", "fede y lore"] },
  { codigo: "PROY 022/2025", nombre: "Nathalie",               alias: ["nathalie", "natalie"] },
];

// ─── Palabras clave para detectar mensajes financieros ───────
const KEYWORDS_FINANZAS = [
  "pagué", "pague", "pago", "pagaron", "me pagaron",
  "compré", "compre", "compra", "compras",
  "gasté", "gaste", "gasto", "gastos",
  "carga", "cargá", "cargame", "cárgame", "cargalo", "cárgalo",
  "cargar", "cárgame", "planilla", "sueldo", "salario", "quincena",
  "registra", "registrame", "registrá", "anota", "apunta",
  "cobré", "cobre", "facturé", "ingreso", "adelanto", "abono",
  "depósito", "deposito", "subcontrato", "subcontratista",
  "materiales", "herramientas", "gasolina", "combustible", "diesel", "diésel",
  "transporte", "flete", "almuerzo", "comida", "alimentacion",
  "ferretería", "ferreteria", "epa", "construplaza",
  "bodega", "inventario", "repuesto",
  "mano de obra", "jornal", "alquiler", "contabilidad", "seguro",
  "colones", "mil colones", "millones",
  "efectivo", "transferencia", "sinpe", "tarjeta",
];

// ─── Fecha hoy en Costa Rica ──────────────────────────────────
const TODAY = () => {
  const cr = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Costa_Rica" }));
  return cr.getFullYear() + "-"
    + String(cr.getMonth() + 1).padStart(2, "0") + "-"
    + String(cr.getDate()).padStart(2, "0");
};

// ─── System prompt del agente financiero ─────────────────────
const buildSystemPrompt = () => {
  const proyectosCtx = PROYECTOS
    .map(p => `- ${p.codigo}: ${p.nombre} (alias: ${p.alias.join(", ")})`)
    .join("\n");

  return `Sos el agente financiero IA de SS Remodelaciones, empresa costarricense de construcción.

PROYECTOS (activos y cerrados — AMBOS pueden recibir gastos):
${proyectosCtx}

REGLAS DE INTERPRETACIÓN:
- "X mil" = X*1000. "medio millón" = 500000
- Sin fecha = hoy: ${TODAY()}
- Detectá proyecto por alias: "fede" → PROY 018/2026, "sergio" → PROY 001/2026
- Proyectos cerrados también reciben gastos (garantías, reparaciones) — no los rechaces
- EPA, Ferretería, Construplaza = categoría "Materiales"
- Gasolina, combustible, diésel = categoría "Gasolina"
- "planilla", "sueldo", pago a trabajador = tipo PLANILLA
- "me pagaron", "adelanto", "abono de cliente", "depósito" = tipo INGRESO
- "inventario", "para bodega", "para stock" = tipo INVENTARIO
- "gimnasio", gastos personales ajenos a SSR = es_personal: true

REGLA CRÍTICA — campo proyecto_codigo:
- Si mencionan un cliente/proyecto específico → usar el código del proyecto (ej: "PROY 018/2026")
- Si es gasto operativo de la empresa SIN proyecto específico (gasolina del pick up, alquiler de oficina, contabilidad, seguro, papelería, etc.) → proyecto_codigo = "SSR"
- NUNCA dejar proyecto_codigo en null para gastos. Si no hay proyecto, usar "SSR"
- Para ingresos sin proyecto específico → proyecto_codigo = null está bien

PESTAÑAS — USA ÚNICAMENTE ESTOS NOMBRES, NINGÚN OTRO:
- "GASTOS_PROYECTO" → CUALQUIER gasto (con proyecto, sin proyecto, proyecto activo o cerrado)
- "INGRESOS_CLIENTES" → pago o adelanto recibido de un cliente
- "BASE_PLANILLA" → pago a empleado, planilla, sueldo, jornal
- "INVENTARIO" → compra para bodega o stock
- "SUBCONTRATOS" → pago a subcontratista externo
PROHIBIDO: nunca uses "GASTOS_GENERALES", "GASTOS_SSR", "CAJA_CHICA" ni nombres inventados.
SIEMPRE incluir "CAJA_GENERAL" en pestanas_adicionales — sin excepción.

CATEGORÍAS VÁLIDAS:
Materiales | Mano de obra | Transporte | Gasolina | Herramientas | Alimentación |
Subcontrato | Personal | Oficina | Marketing | Equipo | Impuestos | Caja chica | Garantía

Respondé ÚNICAMENTE con JSON válido, sin markdown:
{
  "fecha": "YYYY-MM-DD",
  "monto": 15000,
  "tipo": "GASTO",
  "proyecto": "nombre del proyecto o SS Remodelaciones si es operativo",
  "proyecto_codigo": "PROY 018/2026 o SSR — nunca null para gastos",
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
  "observaciones": "nota o null"
}`;
};

// ─── Detectar si el mensaje es financiero ────────────────────
function esComandoFinanciero(texto) {
  if (!texto) return false;
  const t = texto.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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

// ─── Confirmación para WhatsApp ───────────────────────────────
function generarConfirmacion(data, resultado) {
  const tipos = {
    GASTO:      { emoji: "💸", label: "Gasto registrado" },
    INGRESO:    { emoji: "💰", label: "Ingreso registrado" },
    PLANILLA:   { emoji: "👷", label: "Planilla registrada" },
    INVENTARIO: { emoji: "📦", label: "Inventario registrado" },
  };
  const cfg = tipos[data.tipo] || { emoji: "📋", label: "Movimiento registrado" };

  const lineas = [
    `${cfg.emoji} *${cfg.label} en Sheets*`, "",
    `📝 ${data.descripcion}`,
    `💵 *${formatCRC(data.monto)}*`,
  ];

  if (data.proyecto_codigo && data.proyecto_codigo !== "SSR")
    lineas.push(`🏗️ ${data.proyecto_codigo}`);
  else if (data.proyecto_codigo === "SSR")
    lineas.push(`🏢 Gasto operativo SSR`);
  if (data.proveedor)    lineas.push(`🏪 ${data.proveedor}`);
  if (data.forma_pago)   lineas.push(`💳 ${data.forma_pago}`);
  if (data.es_personal)  lineas.push(`👤 Gasto personal`);

  lineas.push(`📊 Pestaña: *${data.pestaña_principal}*`);
  if (data.pestanas_adicionales?.length)
    lineas.push(`📋 Copia en: ${data.pestanas_adicionales.join(", ")}`);
  if (data.confianza < 75)
    lineas.push(`\n⚠️ _Confianza baja (${data.confianza}%) — verificar_`);
  if (data.observaciones)
    lineas.push(`\n📌 ${data.observaciones}`);
  if (resultado?.simulated)
    lineas.push(`\n⚠️ _Modo simulación — revisar APPS_SCRIPT_URL_`);

  lineas.push("", "_Sasha — Agente Financiero SSR_");
  return lineas.join("\n");
}

// ─── Función principal ────────────────────────────────────────
async function procesarComandoFinanciero(texto) {
  if (!esComandoFinanciero(texto)) return null;

  try {
    const datos = await interpretarMovimiento(texto);

    if (!datos.monto || datos.monto <= 0) {
      return "❌ No pude detectar un monto válido.\nEjemplo: _Pagué 25 mil de gasolina para Sergio_";
    }

    const resultado = await registrarEnSheets({
      ...datos,
      audit_id: `SSR-${Date.now()}`,
      canal: "whatsapp",
    });

    if (resultado?.resultado?.status === "DUPLICADO") {
      return `⚠️ *Posible duplicado*\nYa existe un movimiento similar en las últimas 24h.\n📝 ${datos.descripcion} — ${formatCRC(datos.monto)}\n\nSi es correcto, respondé *confirmar* para forzarlo.`;
    }

    return generarConfirmacion(datos, resultado);

  } catch (err) {
    console.error("❌ finanzas.js error:", err.message);
    return null;
  }
}

module.exports = { procesarComandoFinanciero, esComandoFinanciero };
