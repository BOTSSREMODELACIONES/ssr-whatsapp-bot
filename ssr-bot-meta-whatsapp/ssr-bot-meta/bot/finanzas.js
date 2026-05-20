// ============================================================
// finanzas.js — Módulo financiero para Sasha (SS Remodelaciones)
// ============================================================

const Anthropic = require("@anthropic-ai/sdk");

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL ||
  "https://script.google.com/macros/s/AKfycbxpOjoxmar3WsfqwFS1EXJN4uYApUtXph08NSt_q35_6QIX-IP0SuFEqNFqhExRKIvx/exec";

const SHEETS_ID = process.env.SHEETS_ID ||
  "1txCpYo8h30i_GW-aa0M59AwsukgRr3rjlKbgRguz9eA";

const PROYECTOS = [
  { codigo: "PROY 001/2026", nombre: "Sergio Gonzales Pauta",  alias: ["sergio", "gonzales"] },
  { codigo: "PROY 002/2026", nombre: "Jeannette Mora",         alias: ["jeannette", "jeanette"] },
  { codigo: "PROY 016/2026", nombre: "Guillermo",              alias: ["guillermo"] },
  { codigo: "PROY 019/2026", nombre: "Cristián",               alias: ["cristian"] },
  { codigo: "PROY 028/2026", nombre: "Fede",                   alias: ["fede", "federico"] },
  { codigo: "PROY 033/2026", nombre: "Jeannette 033",          alias: ["033"] },
  { codigo: "PROY 043/2026", nombre: "Miriam",                 alias: ["miriam"] },
  { codigo: "PROY 045/2026", nombre: "Juan Diego",             alias: ["juan diego", "juan"] },
  { codigo: "PROY 001/2025", nombre: "César Adrián",           alias: ["cesar", "adrian"] },
  { codigo: "PROY 004/2025", nombre: "Franxi Solano",          alias: ["franxi", "solano"] },
  { codigo: "PROY 008/2025", nombre: "Jorge Córdoba",          alias: ["jorge", "cordoba"] },
  { codigo: "PROY 015/2025", nombre: "Fede y Lore",            alias: ["lore"] },
  { codigo: "PROY 022/2025", nombre: "Nathalie",               alias: ["nathalie", "natalie"] },
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
  "subcontrato","subcontratista",
  "materiales","herramientas","gasolina","combustible","diesel","diésel",
  "transporte","flete","almuerzo","comida","alimentacion",
  "ferretería","ferreteria","epa","construplaza",
  "bodega","inventario","mano de obra",
  "alquiler","contabilidad","seguro","luz","electricidad","agua","internet",
  "colones","mil colones","millones","efectivo","transferencia","sinpe","tarjeta",
];

const TODAY = () => {
  const cr = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Costa_Rica" }));
  return cr.getFullYear() + "-"
    + String(cr.getMonth() + 1).padStart(2, "0") + "-"
    + String(cr.getDate()).padStart(2, "0");
};

const buildSystemPrompt = () => {
  const proyectosCtx = PROYECTOS
    .map(p => `- ${p.codigo}: ${p.nombre} (alias: ${p.alias.join(", ")})`)
    .join("\n");

  return `Sos el agente financiero IA de SS Remodelaciones, empresa costarricense de construcción.

PROYECTOS (activos y cerrados — ambos reciben gastos):
${proyectosCtx}

REGLAS DE INTERPRETACIÓN:
- NÚMEROS COSTARRICENSES: punto = separador de miles → "4.500" = 4500, "1.200.000" = 1200000
- "X mil" = X*1000. "medio millón" = 500000
- Sin fecha = hoy: ${TODAY()}
- Detectá proyecto por alias. Proyectos cerrados también reciben gastos
- Gastos operativos sin proyecto → proyecto_codigo = "SSR"
- SIEMPRE incluir "CAJA_GENERAL" en pestanas_adicionales, EXCEPTO para entradas de planilla sin monto definido

PESTAÑAS — SOLO ESTOS NOMBRES:
- "GASTOS_PROYECTO" → cualquier gasto
- "INGRESOS_CLIENTES" → pago de cliente
- "BASE_PLANILLA" → registro de horas trabajadas y planilla
- "INVENTARIO" → compra para bodega
- "SUBCONTRATOS" → pago a subcontratista

REGLAS PARA PLANILLA (horas trabajadas):
Cuando alguien dice "X trabajó N horas" o "X y Y trabajaron N horas":
- tipo = "PLANILLA"
- pestaña_principal = "BASE_PLANILLA"
- pestanas_adicionales = [] (sin CAJA_GENERAL porque no se sabe el monto total aún)
- monto = 0 (el total bruto se calcula después con la tarifa)
- Usá el campo "horas" para las horas trabajadas
- Usá el campo "vale_colones" para el vale (adelanto en efectivo), 0 si no hay vale
- Si hay vale, el vale SÍ va a CAJA_GENERAL como salida separada
- Cada trabajador = un objeto separado en el array
- Si se menciona un vale, creá un objeto adicional tipo GASTO para registrarlo en CAJA_GENERAL:
  { tipo: "GASTO", descripcion: "Vale planilla [nombre]", monto: [vale], proyecto_codigo: proyecto, pestaña_principal: "GASTOS_PROYECTO", pestanas_adicionales: ["CAJA_GENERAL"] }

INSTRUCCIONES MÚLTIPLES:
Siempre devolvés un ARRAY JSON. Un objeto por operación o trabajador.
Si hay 2 trabajadores = 2 objetos de planilla + 1 objeto por cada vale.

Formato de cada objeto:
{
  "fecha": "YYYY-MM-DD",
  "monto": 0,
  "horas": 9,
  "vale_colones": 15000,
  "tipo": "PLANILLA",
  "proyecto": "nombre del proyecto",
  "proyecto_codigo": "PROY XXX/YYYY o SSR",
  "cliente": null,
  "categoria": "Mano de obra",
  "descripcion": "Planilla Fernando - 9h",
  "responsable": "Fernando",
  "proveedor": null,
  "forma_pago": null,
  "es_personal": false,
  "pestaña_principal": "BASE_PLANILLA",
  "pestanas_adicionales": [],
  "confianza": 95,
  "observaciones": "Vale: ₡15.000" 
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

async function interpretarMovimientos(texto) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1500,
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: texto }],
  });
  const raw   = response.content[0]?.text || "[]";
  const clean = raw.replace(/```json\n?|\n?```/g, "").trim();
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
  if (!res.ok) throw new Error(`Apps Script HTTP ${res.status}`);
  return res.json();
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
  const cfg = tipos[data.tipo] || { emoji: "📋", label: data.tipo };
  const prefijo = total > 1 ? `*${index + 1}/${total}* ` : "";

  const lineas = [`${prefijo}${cfg.emoji} *${cfg.label} registrado*`, `📝 ${data.descripcion}`];

  if (data.tipo === "PLANILLA") {
    if (data.horas)        lineas.push(`🕐 ${data.horas} horas`);
    if (data.vale_colones) lineas.push(`💵 Vale: *${formatCRC(data.vale_colones)}*`);
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
    const movimientos = await interpretarMovimientos(texto);
    if (!movimientos.length) return null;

    const confirmaciones = [];
    const errores = [];

    for (const datos of movimientos) {
      // Para planilla, monto puede ser 0 — es válido
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
