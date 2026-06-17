// ============================================================
// finanzas.js — Módulo financiero para Sasha (SS Remodelaciones)
// ============================================================

const Anthropic = require("@anthropic-ai/sdk");

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL ||
  "https://script.google.com/macros/s/AKfycbxpOjoxmar3WsfqwFS1EXJN4uYApUtXph08NSt_q35_6QIX-IP0SuFEqNFqhExRKIvx/exec";

const SHEETS_ID = process.env.SHEETS_ID ||
  "1txCpYo8h30i_GW-aa0M59AwsukgRr3rjlKbgRguz9eA";

// ⚠️ Códigos VERIFICADOS contra la hoja PROYECTOS (junio 2026).
// Si abrís un proyecto nuevo, agregalo acá con su código EXACTO de la hoja.
// Un código mal escrito = el gasto no aparece en el dashboard (SUMIF no hace match).
const PROYECTOS = [
  // ── Activos / recientes ──
  { codigo: "PROY 030/2026", nombre: "Marriot",               alias: ["marriot", "marriott"] },
  { codigo: "PROY 037/2026", nombre: "Nathalie Alpizar",      alias: ["nathalie", "natalie"] },
  { codigo: "PROY 049/2026", nombre: "Laura Viquez",          alias: ["laura", "viquez"] },
  { codigo: "PROY 045/2026", nombre: "Juan Diego",            alias: ["juan diego"] },
  { codigo: "PROY 044/2026", nombre: "Karim Sanchez",         alias: ["karim", "karin"] },
  { codigo: "PROY 043/2026", nombre: "Miriam Ramirez",        alias: ["miriam"] },
  { codigo: "PROY 033/2026", nombre: "Jeannette",             alias: ["jeannette", "jeanette"] },
  { codigo: "PROY 019/2026", nombre: "Christian Alfaro",      alias: ["cristian", "christian", "alfaro"] },
  { codigo: "PROY 018/2026", nombre: "Anahí Almirón",         alias: ["anahi", "almiron"] },
  { codigo: "PROY 016/2026", nombre: "Frank Solano",          alias: ["frank", "franck", "solano"] },
  { codigo: "PROY 015/2026", nombre: "Guillermo Naranjo",     alias: ["guillermo", "naranjo"] },
  { codigo: "PROY 028/2026", nombre: "Fede y Lore",           alias: ["fede", "lore", "federico"] },
  { codigo: "PROY 006/2026", nombre: "Jorge Cordoba",         alias: ["jorge", "cordoba"] },
  { codigo: "PROY 002/2026", nombre: "Kevin Chanto",          alias: ["kevin", "chanto"] },
  { codigo: "PROY 001/2026", nombre: "Sergio Gonzales",       alias: ["sergio", "gonzales", "pauta"] },
  // ── Históricos cerrados (siguen recibiendo gastos de garantía) ──
  { codigo: "PROY 166/2025", nombre: "Cesar Adrian Montenegro", alias: ["cesar", "adrian", "montenegro"] },
  { codigo: "PROY 154/2025", nombre: "Ruth Valverde",        alias: ["ruth", "valverde"] },
  { codigo: "PROY 151/2025", nombre: "Daniel Marin",         alias: ["daniel", "marin"] },
  { codigo: "PROY SC1/2026", nombre: "Leonardo Alvarez",     alias: ["leonardo", "leo", "alvarez"] },
];

const KEYWORDS_FINANZAS = [
  "pagué","pague","pago","pagaron","me pagaron",
  "compré","compre","compra","compras",
  "gasté","gaste","gasto","gastos",
  "carga","cargá","cargame","cárgame","cargalo","cargar",
  "registra","registrame","registrá","anota","apunta",
  "ingreso","adelanto","abono","depósito","deposito",
  "planilla","sueldo","salario","quincena","jornal",
  "trabajó","trabajo","trabajaron","horas","hora",
  "vale","adelanto planilla",
  "subcontrato","subcontratista","descuenta","desconta","rebaja","apunta","saca","pague","pagé",
  "materiales","herramientas","gasolina","combustible","diesel","diésel",
  "transporte","almuerzo","comida","alimentacion",
  "ferretería","ferreteria","epa","construplaza",
  "bodega","inventario","mano de obra",
  "alquiler","contabilidad","seguro","luz","electricidad","agua","internet",
  "colones","mil colones","millones","efectivo","transferencia","sinpe","tarjeta",
];

// ─── Helpers de fecha ────────────────────────────────────────
const TODAY = () => {
  const cr = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Costa_Rica" }));
  return cr.getFullYear() + "-"
    + String(cr.getMonth() + 1).padStart(2, "0") + "-"
    + String(cr.getDate()).padStart(2, "0");
};

const getMesActual = () => {
  const meses = ["ENERO","FEBRERO","MARZO","ABRIL","MAYO","JUNIO",
                 "JULIO","AGOSTO","SEPTIEMBRE","OCTUBRE","NOVIEMBRE","DICIEMBRE"];
  const cr = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Costa_Rica" }));
  return meses[cr.getMonth()];
};

const getDiaSemana = () => {
  const dias = ["","LUN","MAR","MIÉ","JUE","VIE","SÁB"];
  const cr = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Costa_Rica" }));
  const d = cr.getDay();
  return d === 0 ? "DOM" : dias[d];
};

const getSemanaDelMes = () => {
  const cr = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Costa_Rica" }));
  return Math.ceil(cr.getDate() / 7);
};

const buildSystemPrompt = () => {
  const proyectosCtx = PROYECTOS
    .map(p => `- ${p.codigo}: ${p.nombre} (alias: ${p.alias.join(", ")})`)
    .join("\n");

  const mesActual   = getMesActual();
  const diaSemana   = getDiaSemana();
  const numSemana   = getSemanaDelMes();
  const planillaMes = `PLANILLA_${mesActual}`;

  return `Sos el agente financiero IA de SS Remodelaciones, empresa costarricense de construcción.

PROYECTOS (activos y cerrados — ambos reciben gastos):
${proyectosCtx}

CONTEXTO HOY: ${TODAY()} | Día: ${diaSemana} | Semana del mes: ${numSemana} | Mes planilla: ${planillaMes}

REGLAS DE INTERPRETACIÓN:
- NÚMEROS COSTARRICENSES: punto = separador de miles → "4.500"=4500, "1.200.000"=1200000
- "X mil" = X*1000. "medio millón" = 500000
- Sin fecha = hoy: ${TODAY()}
- Detectá proyecto por nombre o alias. Si el admin menciona un nombre de cliente (ej: "Karim", "Miriam", "Maccaferri"), buscalo en la lista de PROYECTOS de arriba y usá su código exacto.
- Si no encontrás el proyecto por ningún alias → proyecto_codigo = "SSR"
- Gastos operativos sin proyecto claro → proyecto_codigo = "SSR"
- SIEMPRE incluir "CAJA_GENERAL" en pestanas_adicionales (excepto planillas de horas)

PESTAÑAS VÁLIDAS — SOLO ESTOS NOMBRES:
- "GASTOS_PROYECTO" → cualquier gasto
- "INGRESOS_CLIENTES" → pago de cliente
- "${planillaMes}" → registro de horas trabajadas (hoy corresponde a ${planillaMes})
- "BASE_PLANILLA" → copia plana de planilla
- "INVENTARIO" → compra para bodega
- "SUBCONTRATOS" → pago a subcontratista

REGLAS PARA PLANILLA (cuando alguien dice "X trabajó N horas"):
- tipo = "PLANILLA"
- pestaña_principal = "${planillaMes}"
- pestanas_adicionales = ["BASE_PLANILLA"] (sin CAJA_GENERAL, el monto se calcula después)
- monto = 0
- horas = número de horas trabajadas (campo extra obligatorio)
- dia_semana = "${diaSemana}" (día de hoy)
- num_semana = ${numSemana} (semana del mes de hoy)
- vale_colones = monto del vale si hay, 0 si no
- Cada trabajador = un objeto separado en el array
- Si hay vale, agregá UN objeto extra de tipo GASTO: descripcion="Vale planilla [nombre]", monto=[vale], pestaña_principal="GASTOS_PROYECTO", pestanas_adicionales=["CAJA_GENERAL"]

INSTRUCCIONES MÚLTIPLES:
Siempre devolvés un ARRAY JSON. Un objeto por operación o trabajador.

Formato objeto planilla:
{
  "fecha": "${TODAY()}",
  "monto": 0,
  "horas": 9,
  "dia_semana": "${diaSemana}",
  "num_semana": ${numSemana},
  "vale_colones": 0,
  "tipo": "PLANILLA",
  "proyecto": "nombre o SS Remodelaciones",
  "proyecto_codigo": "PROY XXX/YYYY o SSR",
  "categoria": "Mano de obra",
  "descripcion": "Planilla Fernando - 9h ${diaSemana}",
  "responsable": "Fernando",
  "proveedor": null,
  "forma_pago": null,
  "cliente": null,
  "es_personal": false,
  "pestaña_principal": "${planillaMes}",
  "pestanas_adicionales": ["BASE_PLANILLA"],
  "confianza": 95,
  "observaciones": null
}

Formato objeto gasto/ingreso normal:
{
  "fecha": "${TODAY()}",
  "monto": 45000,
  "tipo": "GASTO",
  "proyecto": "nombre o SS Remodelaciones",
  "proyecto_codigo": "SSR",
  "cliente": null,
  "categoria": "Gasolina",
  "descripcion": "3-6 palabras",
  "proveedor": null,
  "forma_pago": null,
  "responsable": null,
  "es_personal": false,
  "pestaña_principal": "GASTOS_PROYECTO",
  "pestanas_adicionales": ["CAJA_GENERAL"],
  "confianza": 95,
  "observaciones": null
}

Respondé ÚNICAMENTE con JSON array válido, sin markdown, sin texto extra.`;
};

function esComandoFinanciero(texto) {
  if (!texto) return false;
  const t = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return KEYWORDS_FINANZAS.some(kw =>
    t.includes(kw.normalize("NFD").replace(/[\u0300-\u036f]/g, ""))
  );
}



// ─── Parser local de montos CR ──────────────────────────────────────────────
// Regla práctica para WhatsApp:
// - "20mil", "20 mil", "20 MIL" => 20000
// - "200mil" => 200000
// - "20.000" => 20000
// - "20,000" => 20000
// - "1.200.000" => 1200000
// - "20" a secas queda 20; para miles usar "20mil".
function parseMontoFinancieroLocal(valor) {
  if (valor === null || valor === undefined) return 0;

  let txt = String(valor)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/₡/g, "")
    .replace(/\bcolones?\b/g, "")
    .trim();

  if (!txt) return 0;
  if (/\bmedio\s+millon\b/.test(txt)) return 500000;

  let m = txt.match(/(\d+(?:[.,]\d+)?)\s*(?:millones?|millon)\b/);
  if (m) {
    const n = Number(m[1].replace(",", "."));
    return isNaN(n) ? 0 : Math.round(n * 1000000);
  }

  m = txt.match(/(\d+(?:[.,]\d+)?)\s*(?:mil|k)\b/);
  if (m) {
    const n = Number(m[1].replace(",", "."));
    return isNaN(n) ? 0 : Math.round(n * 1000);
  }

  m = txt.match(/\d{1,3}(?:[.,]\d{3})+/);
  if (m) return Number(m[0].replace(/[.,]/g, "")) || 0;

  m = txt.match(/\d+/);
  if (m) return Number(m[0]) || 0;

  return 0;
}

function normalizarTextoFinancieroLocal(texto) {
  if (!texto) return "";
  return String(texto)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function extraerMontoDeTextoFinanciero(texto) {
  const t = normalizarTextoFinancieroLocal(texto);

  let m = t.match(/(\d+(?:[.,]\d+)?)\s*(?:mil|k)\b/);
  if (m) return { raw: m[0], monto: parseMontoFinancieroLocal(m[0]) };

  m = t.match(/(\d+(?:[.,]\d+)?)\s*(?:millones?|millon)\b/);
  if (m) return { raw: m[0], monto: parseMontoFinancieroLocal(m[0]) };

  m = t.match(/\d{1,3}(?:[.,]\d{3})+/);
  if (m) return { raw: m[0], monto: parseMontoFinancieroLocal(m[0]) };

  m = t.match(/\d{4,}/);
  if (m) return { raw: m[0], monto: parseMontoFinancieroLocal(m[0]) };

  m = t.match(/\d+/);
  if (m) return { raw: m[0], monto: parseMontoFinancieroLocal(m[0]) };

  return { raw: "", monto: 0 };
}

function extraerComandoFinancieroCrudo(texto) {
  if (!texto) return null;
  const m = String(texto).match(/\[(GASTO|INGRESO)\s*:\s*([^\]]+)\]/i);
  if (!m) return null;

  const tipo = m[1].toUpperCase();
  const partes = m[2].split("|").map(p => p.trim()).filter(Boolean);
  const monto = parseMontoFinancieroLocal(partes[0] || "");
  const descripcion = partes[1] || (tipo === "GASTO" ? "Gasto registrado" : "Ingreso registrado");
  const proyectoTexto = partes[2] || "";

  const proy = detectarProyectoLocal(proyectoTexto || descripcion);

  return [{
    fecha: TODAY(),
    monto,
    tipo,
    proyecto: proy.nombre || proyectoTexto || "SS Remodelaciones",
    proyecto_codigo: proy.codigo || "SSR",
    cliente: tipo === "INGRESO" ? (proy.nombre || proyectoTexto || "") : null,
    categoria: tipo === "GASTO" ? categorizarGastoLocal(descripcion) : "Ingreso cliente",
    descripcion,
    proveedor: null,
    forma_pago: "Transferencia",
    responsable: null,
    es_personal: false,
    "pestaña_principal": tipo === "INGRESO" ? "INGRESOS_CLIENTES" : "GASTOS_PROYECTO",
    pestanas_adicionales: ["CAJA_GENERAL"],
    confianza: 90,
    observaciones: proyectoTexto ? `Proyecto detectado: ${proyectoTexto}` : null
  }];
}

function detectarProyectoLocal(texto) {
  const t = String(texto || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  for (const p of PROYECTOS) {
    const nombre = p.nombre.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const aliases = (p.alias || []).map(a => a.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
    if (t.includes(nombre) || aliases.some(a => a && t.includes(a))) return p;
  }
  return { codigo: "SSR", nombre: "SS Remodelaciones" };
}

function categorizarGastoLocal(desc) {
  const t = String(desc || "").toLowerCase();
  if (/gasolina|combustible|diesel|diésel|aceite|pick up|pickup|veh[ií]culo/.test(t)) return "Transporte";
  if (/material|ferreter|epa|construplaza|lagar|colono/.test(t)) return "Material";
  if (/comida|almuerzo|desayuno|cena|alimentaci/.test(t)) return "Alimentación";
  if (/herramient|equipo|maquina|máquina/.test(t)) return "Herramienta";
  if (/subcontrat|contratista/.test(t)) return "Subcontrato";
  return "Gasto";
}



function extraerMovimientoNaturalLocal(texto) {
  if (!texto) return null;

  const original = String(texto).trim();
  const t = normalizarTextoFinancieroLocal(original);

  const esGasto = /\b(gasto|gaste|gaste|pague|pago|compra|compre|descuenta|desconta|rebaja|apunta|carga|saca)\b/.test(t);
  const esIngreso = /\b(ingreso|me pagaron|pagaron|abono|abonaron|adelanto|deposito|depositaron|transferencia recibida)\b/.test(t);

  if (!esGasto && !esIngreso) return null;

  const { raw, monto } = extraerMontoDeTextoFinanciero(original);
  if (!monto || monto <= 0 || !raw) return null;

  let desc = original;
  desc = desc.replace(new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "").trim();
  desc = desc
    .replace(/^(apunta|anota|registra|carga|descuenta|desconta|rebaja|saca|gasto|pago|pague|compr[eé]|compra|ingreso|me pagaron|pagaron|abono|abonaron)\b\s*/i, "")
    .replace(/\bcolones?\b/ig, "")
    .replace(/^(de|por|para|en|al|a la|a el)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();

  let proyectoTexto = "";
  const pm = desc.match(/\b(?:proyecto|obra|cliente)\s+([a-záéíóúñ0-9\s/.-]+)$/i);
  if (pm) {
    proyectoTexto = pm[1].trim().replace(/[,.]+$/g, "");
    desc = desc.replace(pm[0], "").trim();
  }

  const proy = detectarProyectoLocal(proyectoTexto || desc);
  const tipo = esIngreso && !esGasto ? "INGRESO" : "GASTO";

  return [{
    fecha: TODAY(),
    monto,
    tipo,
    proyecto: proy.nombre || proyectoTexto || "SS Remodelaciones",
    proyecto_codigo: proy.codigo || "SSR",
    cliente: tipo === "INGRESO" ? (proy.nombre || proyectoTexto || "") : null,
    categoria: tipo === "GASTO" ? categorizarGastoLocal(desc) : "Ingreso cliente",
    descripcion: desc || (tipo === "GASTO" ? "Gasto registrado" : "Ingreso registrado"),
    proveedor: null,
    forma_pago: "Transferencia",
    responsable: null,
    es_personal: false,
    "pestaña_principal": tipo === "INGRESO" ? "INGRESOS_CLIENTES" : "GASTOS_PROYECTO",
    pestanas_adicionales: ["CAJA_GENERAL"],
    confianza: 95,
    observaciones: proyectoTexto ? `Proyecto detectado: ${proyectoTexto}` : null
  }];
}

async function interpretarMovimientos(texto) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    // Interpretar un comando de texto corto es tarea simple → Haiku (más barato).
    // Si notás errores de clasificación, subí a claude-sonnet-4-5.
    model: process.env.ANTHROPIC_FINANCE_MODEL || "claude-sonnet-4-5-20250929",
    max_tokens: 1500,
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: texto }],
  });
  const raw    = response.content[0]?.text || "[]";
  const clean  = raw.replace(/```json\n?|\n?```/g, "").trim();
  const parsed = JSON.parse(clean);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function registrarEnSheets(data) {
  if (!APPS_SCRIPT_URL) return { success: true, simulated: true };
  const res = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`Apps Script HTTP ${res.status}: ${bodyText}`);
  try {
    return JSON.parse(bodyText);
  } catch (e) {
    throw new Error(`Apps Script respondió no-JSON: ${bodyText.slice(0, 300)}`);
  }
}

function formatCRC(n) {
  return `₡${Number(n).toLocaleString("es-CR")}`;
}

function generarConfirmacionItem(data, index, total) {
  const tipos = {
    GASTO:      { emoji: "💸", label: "Gasto" },
    INGRESO:    { emoji: "💰", label: "Ingreso" },
    PLANILLA:   { emoji: "👷", label: "Planilla" },
    INVENTARIO: { emoji: "📦", label: "Inventario" },
  };
  const cfg    = tipos[data.tipo] || { emoji: "📋", label: data.tipo };
  const prefijo = total > 1 ? `*${index + 1}/${total}* ` : "";

  const lineas = [`${prefijo}${cfg.emoji} *${cfg.label} registrado*`, `📝 ${data.descripcion}`];

  if (data.tipo === "PLANILLA") {
    if (data.horas)         lineas.push(`🕐 ${data.horas} horas — ${data.dia_semana || ""}`);
    if (data.vale_colones)  lineas.push(`💵 Vale: *${formatCRC(data.vale_colones)}*`);
    if (data.proyecto_codigo && data.proyecto_codigo !== "SSR")
      lineas.push(`🏗️ ${data.proyecto_codigo}`);
  } else {
    lineas.push(`💵 *${formatCRC(data.monto)}*`);
    if (data.proyecto_codigo && data.proyecto_codigo !== "SSR")
      lineas.push(`🏗️ ${data.proyecto_codigo}`);
    else if (data.proyecto_codigo === "SSR")
      lineas.push(`🏢 SSR`);
    if (data.cliente) lineas.push(`👤 ${data.cliente}`);
  }
  lineas.push(`📊 ${data.pestaña_principal}`);
  if (data.observaciones) lineas.push(`📌 ${data.observaciones}`);
  return lineas.join("\n");
}

async function procesarComandoFinanciero(texto) {
  if (!esComandoFinanciero(texto)) return null;

  try {
    const movimientos = extraerComandoFinancieroCrudo(texto) || extraerMovimientoNaturalLocal(texto) || await interpretarMovimientos(texto);
    if (!movimientos.length) return null;

    const confirmaciones = [];
    const errores = [];

    for (const datos of movimientos) {
      const esPlanilla = datos.tipo === "PLANILLA";
      if (!esPlanilla && (!datos.monto || datos.monto <= 0)) {
        errores.push(`❌ Monto inválido: ${datos.descripcion || "sin descripción"}`);
        continue;
      }

      try {
        const resultado = await registrarEnSheets({
          ...datos,
          audit_id: `SSR-${Date.now()}`,
          canal: "whatsapp",
        });

        if (resultado?.resultado?.status === "DUPLICADO") {
          errores.push(`⚠️ Duplicado: ${datos.descripcion}`);
        } else {
          confirmaciones.push(
            generarConfirmacionItem(datos, confirmaciones.length, movimientos.length)
          );
        }
      } catch (err) {
        console.error("❌ Error:", err.message);
        errores.push(`❌ Error en: ${datos.descripcion}`);
      }
    }

    const partes = [];
    if (confirmaciones.length)
      partes.push(confirmaciones.join("\n\n─────────────\n\n"));
    if (errores.length)
      partes.push(errores.join("\n"));
    partes.push("_Sasha — Agente Financiero SSR_");

    return partes.join("\n\n");

  } catch (err) {
    console.error("❌ finanzas.js error:", err.message);
    return null;
  }
}

module.exports = { procesarComandoFinanciero, esComandoFinanciero };
