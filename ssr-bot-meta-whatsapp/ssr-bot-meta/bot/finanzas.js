// ============================================================
// finanzas.js — Módulo financiero para Sasha (SS Remodelaciones)
// v8 — FIX: detección de moneda (USD), proyecto robusto a typos,
//      y fallback híbrido a Claude cuando la confianza local es baja.
// ============================================================

const Anthropic = require("@anthropic-ai/sdk");

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL ||
  "https://script.google.com/macros/s/AKfycbxpOjoxmar3WsfqwFS1EXJN4uYApUtXph08NSt_q35_6QIX-IP0SuFEqNFqhExRKIvx/exec";

const SHEETS_ID = process.env.SHEETS_ID ||
  "1txCpYo8h30i_GW-aa0M59AwsukgRr3rjlKbgRguz9eA";

// Tipo de cambio USD → CRC. Ajustalo aquí o vía variable de entorno TIPO_CAMBIO_USD.
// Esto NO convierte el monto silenciosamente sin que lo veas: el mensaje de
// confirmación siempre muestra el monto original en USD Y su equivalente en ₡.
const TIPO_CAMBIO_USD = Number(process.env.TIPO_CAMBIO_USD) || 506;

// ⚠️ Códigos VERIFICADOS contra la hoja PROYECTOS (junio 2026).
// Si abrís un proyecto nuevo, agregalo acá con su código EXACTO de la hoja.
// Un código mal escrito = el gasto no aparece en el dashboard (SUMIF no hace match).
const PROYECTOS = [
  // ── Activos / recientes ──────────────────────────────────────────────────
  { codigo: "PROY 060/2026", nombre: "María José",               alias: ["maria jose", "mariajose", "balcon", "balcon maria jose"] },
  { codigo: "PROY 059/2026", nombre: "Rosalía Granados",         alias: ["rosalia", "granados", "closet rosalia"] },
  { codigo: "PROY 049/2026", nombre: "Laura Víquez",             alias: ["laura", "viquez", "consultorio laura"] },
  { codigo: "PROY 045/2026", nombre: "Juan Diego",               alias: ["juan diego", "juan", "anexo juan"] },
  { codigo: "PROY 044/2026", nombre: "Karim Sánchez",            alias: ["karim", "karin", "sanchez"] },
  { codigo: "PROY 043/2026", nombre: "Miriam Ramírez Cordero",   alias: ["miriam", "ramirez", "enchape miriam"] },
  { codigo: "PROY 037/2026", nombre: "Nathalie Alpízar",         alias: ["nathalie", "natalie", "alpizar", "baño nathalie"] },
  { codigo: "PROY 033/2026", nombre: "Jeannette",                alias: ["jeannette", "jeanette", "cocina jeannette"] },
  { codigo: "PROY 030/2026", nombre: "Marriott",                 alias: ["marriott", "marriot", "mariot", "hotel marriott", "diversa marriott"] },
  { codigo: "PROY 028/2026", nombre: "Fede y Lore",              alias: ["fede", "lore", "federico", "banos fede"] },
  { codigo: "PROY 019/2026", nombre: "Christian Alfaro",         alias: ["christian", "cristian", "alfaro", "ventanas", "ventaneria", "ventanería", "jonathan ventanas"] },
  { codigo: "PROY 018/2026", nombre: "Anahí Almirón",            alias: ["anahi", "almiron", "almirón", "salon belleza", "muebles salon"] },
  { codigo: "PROY 016/2026", nombre: "Frank Solano",             alias: ["frank", "franck", "solano", "baño frank", "bano frank"] },
  { codigo: "PROY 015/2026", nombre: "Guillermo Naranjo",        alias: ["guillermo", "naranjo", "pintura interior"] },
  { codigo: "PROY 006/2026", nombre: "Jorge Córdoba 2026",       alias: ["jorge", "cordoba", "chorreadosa", "losa"] },
  { codigo: "PROY 002/2026", nombre: "Kevin Chanto",             alias: ["kevin", "chanto"] },
  { codigo: "PROY 001/2026", nombre: "Leonardo Álvarez",         alias: ["leonardo", "leo", "alvarez", "panel acanalado"] },
  // ── Históricos cerrados (siguen recibiendo gastos de garantía) ───────────
  { codigo: "PROY 166/2025", nombre: "César Adrián Montenegro",  alias: ["cesar", "adrian", "montenegro"] },
  { codigo: "PROY 154/2025", nombre: "Ruth Valverde Aguilar",    alias: ["ruth", "valverde", "escazu"] },
  { codigo: "PROY 151/2025", nombre: "Daniel Marín Ortega",      alias: ["daniel", "marin", "cocina daniel"] },
  { codigo: "PROY 022/2025", nombre: "Nathalie Alpízar 2025",    alias: ["nathalie 2025"] },
  { codigo: "PROY 015/2025", nombre: "Fede y Lore 2025",         alias: ["lore 2025"] },
  { codigo: "PROY 008/2025", nombre: "Jorge Córdoba 2025",       alias: ["cordoba 2025"] },
  { codigo: "PROY 004/2025", nombre: "Franxi Solano",            alias: ["franxi"] },
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
  "usd","dolar","dolares","dólar","dólares",
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
- MONEDA: si el mensaje menciona "usd", "dólares", "dolares" o "$" antes/después del número,
  el monto está en USD. En ese caso devolvé "moneda": "USD" y "monto" en USD (NO conviertas).
  Si no se menciona moneda extranjera, asumí colones y "moneda": "CRC".
- Sin fecha = hoy: ${TODAY()}
- Detectá proyecto por nombre o alias EN CUALQUIER PARTE del mensaje, incluso con errores
  de tipeo leves (ej: "poryecto", "marriot" sin la segunda T). Si el admin menciona un
  nombre de cliente o proyecto, buscalo en la lista de PROYECTOS de arriba y usá su código exacto.
- Si no encontrás el proyecto por ningún alias → proyecto_codigo = "SSR"
- Gastos operativos sin proyecto claro → proyecto_codigo = "SSR"
- SIEMPRE incluir "CAJA_GENERAL" en pestanas_adicionales (excepto planillas de horas)
- La descripción debe ser un resumen claro de 3-8 palabras del MOTIVO del gasto/ingreso
  (ej: "Transporte operarios Marriott", "Materiales gypsum"). NUNCA dejes la descripción
  vacía o con fragmentos sueltos de la frase original.

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
  "moneda": "CRC",
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
REGLA CRÍTICA — pago de planilla SIN mención de horas trabajadas:
Si el mensaje dice "pago de planilla a [nombre] por [monto]" o similar, y NO menciona
horas trabajadas ("trabajó X horas"), es un VALE/ADELANTO, NO un registro de horas.
Tratalo así:
{
  "tipo": "GASTO",
  "monto": [el monto mencionado],
  "moneda": "CRC" (o "USD" si aplica),
  "categoria": "Mano de obra",
  "descripcion": "Vale planilla [nombre]",
  "responsable": "[nombre]",
  "proyecto_codigo": "[código si el mensaje menciona proyecto, si no 'SSR']",
  "pestaña_principal": "GASTOS_PROYECTO",
  "pestanas_adicionales": ["CAJA_GENERAL"],
  "confianza": 90
}
NUNCA uses tipo="PLANILLA" con monto=0 para este caso — el monto es real y si lo
forzás a 0, el gasto desaparece silenciosamente sin que nadie se entere.
Formato objeto gasto/ingreso normal:
{
  "fecha": "${TODAY()}",
  "monto": 45000,
  "moneda": "CRC",
  "tipo": "GASTO",
  "proyecto": "nombre o SS Remodelaciones",
  "proyecto_codigo": "SSR",
  "cliente": null,
  "categoria": "Gasolina",
  "descripcion": "3-8 palabras claras",
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

// ─── Detección de moneda ─────────────────────────────────────────────────────
function detectarMonedaLocal(texto) {
  const t = String(texto || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/\busd\b/.test(t) || /\bdolar(es)?\b/.test(t) || /\$\s*\d/.test(t) || /\d\s*\$/.test(t)) {
    return "USD";
  }
  return "CRC";
}

// ─── Parser local de montos CR ──────────────────────────────────────────────
function parseMontoFinancieroLocal(valor) {
  if (valor === null || valor === undefined) return 0;

  let txt = String(valor)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/₡/g, "")
    .replace(/\$/g, "")
    .replace(/\busd\b/g, "")
    .replace(/\bdolar(es)?\b/g, "")
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

  m = txt.match(/\d+(?:[.,]\d+)?/);
  if (m) return Number(m[0].replace(",", ".")) || 0;

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

  let m = t.match(/\$\s*\d+(?:[.,]\d+)?/);
  if (m) return { raw: m[0], monto: parseMontoFinancieroLocal(m[0]) };

  m = t.match(/\d+(?:[.,]\d+)?\s*\$/);
  if (m) return { raw: m[0], monto: parseMontoFinancieroLocal(m[0]) };

  m = t.match(/\d+(?:[.,]\d+)?\s*(?:usd|dolares|dolar)\b/);
  if (m) return { raw: m[0], monto: parseMontoFinancieroLocal(m[0]) };

  m = t.match(/(?:usd|dolares|dolar)\s*\d+(?:[.,]\d+)?/);
  if (m) return { raw: m[0], monto: parseMontoFinancieroLocal(m[0]) };

  m = t.match(/(\d+(?:[.,]\d+)?)\s*(?:mil|k)\b/);
  if (m) return { raw: m[0], monto: parseMontoFinancieroLocal(m[0]) };

  m = t.match(/(\d+(?:[.,]\d+)?)\s*(?:millones?|millon)\b/);
  if (m) return { raw: m[0], monto: parseMontoFinancieroLocal(m[0]) };

  m = t.match(/\d{1,3}(?:[.,]\d{3})+/);
  if (m) return { raw: m[0], monto: parseMontoFinancieroLocal(m[0]) };

  m = t.match(/\d{4,}/);
  if (m) return { raw: m[0], monto: parseMontoFinancieroLocal(m[0]) };

  m = t.match(/\d+(?:[.,]\d+)?/);
  if (m) return { raw: m[0], monto: parseMontoFinancieroLocal(m[0]) };

  return { raw: "", monto: 0 };
}

function categorizarGastoLocal(desc) {
  const t = String(desc || "").toLowerCase();
  if (/gasolina|combustible|diesel|diésel|aceite|pick up|pickup|veh[ií]culo|transporte/.test(t)) return "Transporte";
  if (/material|ferreter|epa|construplaza|lagar|colono/.test(t)) return "Material";
  if (/comida|almuerzo|desayuno|cena|alimentaci/.test(t)) return "Alimentación";
  if (/herramient|equipo|maquina|máquina/.test(t)) return "Herramienta";
  if (/subcontrat|contratista/.test(t)) return "Subcontrato";
  return "Gasto";
}

// ─── Detección de proyecto robusta (Levenshtein) ─────────────────────────────
function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const dp = Array.from({ length: al + 1 }, (_, i) => [i, ...Array(bl).fill(0)]);
  for (let j = 0; j <= bl; j++) dp[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[al][bl];
}

function detectarProyectoLocal(texto) {
  const t = String(texto || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const palabras = t.split(/[^a-z0-9]+/).filter(Boolean);

  // 1) Match exacto por substring
  for (const p of PROYECTOS) {
    const nombre = p.nombre.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const aliases = (p.alias || []).map(a => a.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
    if (t.includes(nombre) || aliases.some(a => a && t.includes(a))) return p;
  }

  // 2) Match tolerante a typos
  for (const p of PROYECTOS) {
    const aliases = (p.alias || []).map(a => a.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
    for (const alias of aliases) {
      if (alias.length < 4) continue;
      for (const palabra of palabras) {
        if (palabra.length < 4) continue;
        const dist = levenshtein(alias, palabra);
        if (dist <= Math.max(1, Math.floor(alias.length / 5))) return p;
      }
    }
  }

  return { codigo: "SSR", nombre: "SS Remodelaciones" };
}

function extraerComandoFinancieroCrudo(texto) {
  if (!texto) return null;
  const m = String(texto).match(/\[(GASTO|INGRESO)\s*:\s*([^\]]+)\]/i);
  if (!m) return null;

  const tipo = m[1].toUpperCase();
  const partes = m[2].split("|").map(p => p.trim()).filter(Boolean);
  const moneda = detectarMonedaLocal(partes[0] || "");
  const monto = parseMontoFinancieroLocal(partes[0] || "");
  const descripcion = partes[1] || (tipo === "GASTO" ? "Gasto registrado" : "Ingreso registrado");
  const proyectoTexto = partes[2] || "";

  const proy = detectarProyectoLocal(proyectoTexto || `${descripcion} ${texto}`);
  const montoCRC = moneda === "USD" ? Math.round(monto * TIPO_CAMBIO_USD) : monto;

  return [{
    fecha: TODAY(),
    monto: montoCRC,
    monto_original: monto,
    moneda,
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
    observaciones: moneda === "USD"
      ? `Monto original: $${monto} USD (TC ₡${TIPO_CAMBIO_USD})${proyectoTexto ? ` | Proyecto detectado: ${proyectoTexto}` : ""}`
      : (proyectoTexto ? `Proyecto detectado: ${proyectoTexto}` : null),
  }];
}

const CONECTORES_SIN_CONTENIDO = new Set([
  "el","la","los","las","un","una","unos","unas","de","del","al","a","en",
  "para","por","con","y","o","que","su","sus","lo","le","se","es","son",
]);

function construirDescripcionLocal(original, raw, proyectoTextoExtraido) {
  let desc = original;

  if (raw) {
    desc = desc.replace(new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "").trim();
  }
  desc = desc
    .replace(/\busd\b/ig, "")
    .replace(/\bdolar(es)?\b/ig, "")
    .replace(/\$/g, "")
    .replace(/^(apunta|anota|anotame|registra|registrame|carga|cargame|descuenta|desconta|rebaja|saca|gasto|pago|pague|compr[eé]|compra|ingreso|me pagaron|pagaron|abono|abonaron)\b\s*/i, "")
    .replace(/\b(el|un|la|una)\s+(pago|gasto|ingreso|abono|adelanto)\s+de\b/ig, "")
    .replace(/\b(pague|pago|gasto|ingreso|abono|adelanto)\s+de\b/ig, "")
    .replace(/\bcolones?\b/ig, "")
    .trim();

  if (proyectoTextoExtraido) {
    const re = new RegExp(
      "\\s*(?:,)?\\s*(?:para|en|de|del|al|el|la)?\\s*(?:para|en|de|del|al|el|la)?\\s*(?:proyecto|obra|cliente)\\s+(?:de\\s+|del\\s+)?" +
      proyectoTextoExtraido.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b.*$",
      "i"
    );
    desc = desc.replace(re, "").trim();
  }

  let prev;
  do {
    prev = desc;
    desc = desc
      .replace(/^(de|del|por|para|en|al|a la|a el|y)\s+/i, "")
      .replace(/\s+(de|del|por|para|en|al|a la|a el|y)$/i, "")
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s,.-]+|[\s,.-]+$/g, "")
      .trim();
  } while (desc !== prev && desc.length > 0);

  if (!desc) return null;

  const palabrasConContenido = desc
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 1 && !CONECTORES_SIN_CONTENIDO.has(w));

  if (palabrasConContenido.length < 1) return null;

  return desc;
}

const MAX_PALABRAS_PARSER_LOCAL = 11;

function extraerMovimientoNaturalLocal(texto) {
  if (!texto) return null;

  const original = String(texto).trim();
  const t = normalizarTextoFinancieroLocal(original);

  const esGasto = /\b(gasto|gaste|pague|pago|compra|compre|descuenta|desconta|rebaja|saca)\b/.test(t);
  const esIngreso = /\b(ingreso|me pagaron|pagaron|abono|abonaron|adelanto|deposito|depositaron|transferencia recibida)\b/.test(t);
  const esComandoNeutro = /\b(apunta|anota|registra|carga)\b/.test(t);

  if (!esGasto && !esIngreso && !esComandoNeutro) return null;

  const cantidadPalabras = original.split(/\s+/).filter(Boolean).length;
  if (cantidadPalabras > MAX_PALABRAS_PARSER_LOCAL) return null;

  const { raw, monto } = extraerMontoDeTextoFinanciero(original);
  if (!monto || monto <= 0 || !raw) return null;

  const moneda = detectarMonedaLocal(original);
  const montoCRC = moneda === "USD" ? Math.round(monto * TIPO_CAMBIO_USD) : monto;

  let proyectoTexto = "";
  const pm = original.match(/\b(?:proyecto|obra|cliente)\s+(?:de\s+|del\s+)?([a-záéíóúñ0-9\s/.-]+?)(?:\s+(?:para|por|en|de)\b|$)/i);
  if (pm) proyectoTexto = pm[1].trim().replace(/[,.]+$/g, "").replace(/^(de|del)\s+/i, "");

  const desc = construirDescripcionLocal(original, raw, proyectoTexto);
  const proy = detectarProyectoLocal(proyectoTexto || original);

  let tipo;
  if (esIngreso && !esGasto) {
    tipo = "INGRESO";
  } else if (esGasto && !esIngreso) {
    tipo = "GASTO";
  } else {
    return null; // ambiguo → fallback a Claude
  }

  if (!desc) return null;

  return [{
    fecha: TODAY(),
    monto: montoCRC,
    monto_original: monto,
    moneda,
    tipo,
    proyecto: proy.nombre || proyectoTexto || "SS Remodelaciones",
    proyecto_codigo: proy.codigo || "SSR",
    cliente: tipo === "INGRESO" ? (proy.nombre || proyectoTexto || "") : null,
    categoria: tipo === "GASTO" ? categorizarGastoLocal(desc) : "Ingreso cliente",
    descripcion: desc,
    proveedor: null,
    forma_pago: "Transferencia",
    responsable: null,
    es_personal: false,
    "pestaña_principal": tipo === "INGRESO" ? "INGRESOS_CLIENTES" : "GASTOS_PROYECTO",
    pestanas_adicionales: ["CAJA_GENERAL"],
    confianza: 95,
    observaciones: moneda === "USD"
      ? `Monto original: $${monto} USD (TC ₡${TIPO_CAMBIO_USD})${proyectoTexto ? ` | Proyecto detectado: ${proyectoTexto}` : ""}`
      : (proyectoTexto ? `Proyecto detectado: ${proyectoTexto}` : null),
  }];
}

async function interpretarMovimientos(texto) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: process.env.ANTHROPIC_FINANCE_MODEL || "claude-sonnet-4-5-20250929",
    max_tokens: 1500,
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: texto }],
  });
  const raw    = response.content[0]?.text || "[]";
  const clean  = raw.replace(/```json\n?|\n?```/g, "").trim();
  const parsed = JSON.parse(clean);
  const movimientos = Array.isArray(parsed) ? parsed : [parsed];

  return movimientos.map(m => {
    const moneda = m.moneda === "USD" ? "USD" : "CRC";
    const montoOriginal = Number(m.monto) || 0;
    const montoCRC = moneda === "USD" ? Math.round(montoOriginal * TIPO_CAMBIO_USD) : montoOriginal;
    return {
      ...m,
      moneda,
      monto: montoCRC,
      monto_original: montoOriginal,
      observaciones: moneda === "USD"
        ? `Monto original: $${montoOriginal} USD (TC ₡${TIPO_CAMBIO_USD})${m.observaciones ? ` | ${m.observaciones}` : ""}`
        : (m.observaciones || null),
    };
  });
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
    if (data.moneda === "USD" && data.monto_original) {
      lineas.push(`💵 *$${Number(data.monto_original).toLocaleString("en-US")} USD* (≈ ${formatCRC(data.monto)})`);
    } else {
      lineas.push(`💵 *${formatCRC(data.monto)}*`);
    }
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
    let movimientos = extraerComandoFinancieroCrudo(texto) || extraerMovimientoNaturalLocal(texto);

    if (!movimientos) {
      movimientos = await interpretarMovimientos(texto);
    }

    if (!movimientos || !movimientos.length) return null;

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
