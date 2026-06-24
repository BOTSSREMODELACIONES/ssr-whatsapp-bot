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
// Busca señales explícitas de USD en el texto. Si no encuentra nada, asume CRC.
// Importante: esto corre ANTES de extraer el monto, sobre el texto COMPLETO,
// para no depender de que el número y la moneda queden pegados.
function detectarMonedaLocal(texto) {
  const t = String(texto || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/\busd\b/.test(t) || /\bdolar(es)?\b/.test(t) || /\$\s*\d/.test(t) || /\d\s*\$/.test(t)) {
    return "USD";
  }
  return "CRC";
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

// Extrae el monto buscando primero un número que esté pegado a una señal de
// moneda (usd, $, mil, millon), y si no, cualquier número suelto.
// Devuelve también el "raw" exacto que matcheó, para poder quitarlo de la
// descripción más adelante sin destruir el resto de la frase.
function extraerMontoDeTextoFinanciero(texto) {
  const t = normalizarTextoFinancieroLocal(texto);

  // Número + "usd"/"dolares"/"$" pegado (en cualquier orden) — máxima prioridad,
  // así el monto y su unidad se quitan juntos de la descripción.
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

// ─── Detección de proyecto robusta ──────────────────────────────────────────
// Distancia de Levenshtein simple, para tolerar errores de tipeo cortos
// (ej. "marriot" vs "marriott", o un alias con una letra de más/menos).
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

// Busca un proyecto por alias/nombre EN CUALQUIER PARTE del texto completo
// (no solo al final, no solo tras la palabra "proyecto"). Tolera errores de
// tipeo cortos en las palabras del texto comparándolas con cada alias.
function detectarProyectoLocal(texto) {
  const t = String(texto || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const palabras = t.split(/[^a-z0-9]+/).filter(Boolean);

  // 1) Match exacto por substring (rápido, cubre el caso normal)
  for (const p of PROYECTOS) {
    const nombre = p.nombre.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const aliases = (p.alias || []).map(a => a.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
    if (t.includes(nombre) || aliases.some(a => a && t.includes(a))) return p;
  }

  // 2) Match tolerante a typos: compara cada palabra del texto contra cada alias.
  //    Solo para alias de 4+ letras (evita falsos positivos con palabras cortas).
  for (const p of PROYECTOS) {
    const aliases = (p.alias || []).map(a => a.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
    for (const alias of aliases) {
      if (alias.length < 4) continue;
      for (const palabra of palabras) {
        if (palabra.length < 4) continue;
        const dist = levenshtein(alias, palabra);
        // Tolerancia: 1 error cada ~5 caracteres del alias.
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

// Conectores/preposiciones sin contenido propio — no cuentan como "palabra útil"
// al evaluar si la descripción resultante tiene sentido.
const CONECTORES_SIN_CONTENIDO = new Set([
  "el","la","los","las","un","una","unos","unas","de","del","al","a","en",
  "para","por","con","y","o","que","su","sus","lo","le","se","es","son",
]);

// Quita del texto el fragmento de monto+moneda detectado, palabras de comando
// al inicio, y conectores sueltos al borde. Si el resultado no tiene al menos
// 3 palabras con contenido real (sustantivos/verbos), devuelve null para
// forzar el fallback a Claude — preferimos una llamada extra a la API antes
// que guardar una descripción ilegible en la hoja.
function construirDescripcionLocal(original, raw, proyectoTextoExtraido) {
  let desc = original;

  if (raw) {
    desc = desc.replace(new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "").trim();
  }
  // Por si quedó un "usd"/"dolares"/"$" suelto que no estaba pegado al número.
  desc = desc
    .replace(/\busd\b/ig, "")
    .replace(/\bdolar(es)?\b/ig, "")
    .replace(/\$/g, "")
    .replace(/^(apunta|anota|anotame|registra|registrame|carga|cargame|descuenta|desconta|rebaja|saca|gasto|pago|pague|compr[eé]|compra|ingreso|me pagaron|pagaron|abono|abonaron)\b\s*/i, "")
    // "el/un gasto de" o "el/un ingreso de" sueltos en cualquier posición de la
    // frase (no solo al inicio) — cubre "Apunta el ingreso de 71393..." donde
    // "ingreso" no es la primera palabra.
    .replace(/\b(el|un|la|una)\s+(pago|gasto|ingreso|abono|adelanto)\s+de\b/ig, "")
    .replace(/\b(pague|pago|gasto|ingreso|abono|adelanto)\s+de\b/ig, "")
    .replace(/\bcolones?\b/ig, "")
    .trim();

  // Si ya extrajimos el proyecto por separado (ej: "para el proyecto Marriot" al
  // final), cortamos desde donde empieza esa mención hasta el final de la frase,
  // para no repetir el proyecto dentro de la descripción.
  if (proyectoTextoExtraido) {
    const re = new RegExp(
      "\\s*(?:,)?\\s*(?:para|en|de|del|al|el|la)?\\s*(?:para|en|de|del|al|el|la)?\\s*(?:proyecto|obra|cliente)\\s+(?:de\\s+|del\\s+)?" +
      proyectoTextoExtraido.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b.*$",
      "i"
    );
    desc = desc.replace(re, "").trim();
  }

  // Conectores sueltos al inicio/fin pueden quedar anidados (ej: "de" se quita
  // y deja "en gasolina"). Repetimos la limpieza hasta que se estabilice.
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

// Por encima de este número de palabras, una frase es conversacional/compleja
// (típica de un mensaje de voz transcrito o un mensaje escrito sin pensar en
// "formato de comando"). El parser local con regex encadenados se vuelve poco
// confiable a esta longitud — preferimos que Claude la interprete directamente.
const MAX_PALABRAS_PARSER_LOCAL = 11;

function extraerMovimientoNaturalLocal(texto) {
  if (!texto) return null;

  const original = String(texto).trim();
  const t = normalizarTextoFinancieroLocal(original);

  // Verbos como "apunta", "anota", "registra", "carga" son NEUTROS — Darwin los
  // usa tanto para gastos ("apunta el gasto...") como para ingresos ("apunta el
  // ingreso..."). Si los incluyéramos en esGasto, un mensaje de ingreso con el
  // verbo "apunta" calificaría como ambos a la vez y el desempate caería mal.
  // Solo palabras que indican GASTO específicamente:
  const esGasto = /\b(gasto|gaste|pague|pago|compra|compre|descuenta|desconta|rebaja|saca)\b/.test(t);
  // Solo palabras que indican INGRESO específicamente:
  const esIngreso = /\b(ingreso|me pagaron|pagaron|abono|abonaron|adelanto|deposito|depositaron|transferencia recibida)\b/.test(t);
  // Verbos neutros que disparan el parser financiero pero no deciden el tipo:
  const esComandoNeutro = /\b(apunta|anota|registra|carga)\b/.test(t);

  if (!esGasto && !esIngreso && !esComandoNeutro) return null;

  const cantidadPalabras = original.split(/\s+/).filter(Boolean).length;
  if (cantidadPalabras > MAX_PALABRAS_PARSER_LOCAL) return null;

  const { raw, monto } = extraerMontoDeTextoFinanciero(original);
  if (!monto || monto <= 0 || !raw) return null;

  const moneda = detectarMonedaLocal(original);
  const montoCRC = moneda === "USD" ? Math.round(monto * TIPO_CAMBIO_USD) : monto;

  // Proyecto: buscamos en el TEXTO COMPLETO original, no en la descripción ya
  // recortada — así no depende de que "proyecto X" quede al final de la frase
  // ni de que la palabra "proyecto" esté bien escrita.
  let proyectoTexto = "";
  const pm = original.match(/\b(?:proyecto|obra|cliente)\s+(?:de\s+|del\s+)?([a-záéíóúñ0-9\s/.-]+?)(?:\s+(?:para|por|en|de)\b|$)/i);
  if (pm) proyectoTexto = pm[1].trim().replace(/[,.]+$/g, "").replace(/^(de|del)\s+/i, "");

  const desc = construirDescripcionLocal(original, raw, proyectoTexto);

  const proy = detectarProyectoLocal(proyectoTexto || original);

  // Desempate explícito de tipo:
  // - Señal de ingreso sin señal de gasto → INGRESO
  // - Señal de gasto sin señal de ingreso → GASTO
  // - Ambas señales específicas a la vez, o ninguna (solo verbo neutro como
  //   "apunta" sin que diga ni "gasto" ni "ingreso") → ambiguo, mejor que lo
  //   resuelva Claude con el contexto completo en vez de asumir GASTO a ciegas.
  let tipo;
  if (esIngreso && !esGasto) {
    tipo = "INGRESO";
  } else if (esGasto && !esIngreso) {
    tipo = "GASTO";
  } else {
    return null; // ambiguo → fallback a Claude
  }

  // ── Cálculo de confianza local ──────────────────────────────────────────
  // Si la descripción no se pudo construir de forma limpia, es señal de que
  // la frase es larga/compleja y el parser local no es confiable acá:
  // devolvemos null para que el caller haga fallback a Claude.
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

  // Asegura que el campo moneda y la conversión a CRC siempre estén presentes,
  // incluso si Claude no lo incluyó por alguna razón.
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
    // Orden híbrido:
    // 1. Comando estructurado [GASTO: ...] / [INGRESO: ...] → siempre local, es inequívoco.
    // 2. Lenguaje natural → parser local SOLO si construye una descripción limpia
    //    (extraerMovimientoNaturalLocal devuelve null si no puede, forzando el fallback).
    // 3. Si el parser local no pudo, Claude interpreta la frase completa.
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
