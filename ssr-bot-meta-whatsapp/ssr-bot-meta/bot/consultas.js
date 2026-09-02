// ============================================================
// consultas.js — Módulo de consultas conversacionales para Sasha
// SS Remodelaciones
//
// Responde preguntas de SOLO LECTURA sobre datos ya registrados en
// el ERP (pagos/ingresos por cliente, gastos por proyecto) sin
// escribir nada. Existe como módulo SEPARADO de finanzas.js (que
// solo escribe) para que un mensaje como "resumen de los pagos de
// Jose Flores" no se confunda con un comando de registro.
//
// BUG REAL QUE ORIGINÓ ESTE MÓDULO (2 sept 2026):
// esComandoFinanciero() de finanzas.js clasifica por
// `t.includes(keyword)`, y "pago" es substring literal de "pagos".
// Como el mensaje de consulta no traía ningún dígito, caía en
// esComandoFinancieroSinMonto() → Sasha respondía "Anotado, mandame
// la foto del comprobante..." en vez de responder la consulta.
//
// FIX: index.js debe llamar a esConsultaFinanciera() ANTES de
// esComandoFinanciero(). Si devuelve true, se enruta acá — nunca
// llega a finanzas.js.
// ============================================================

import Anthropic from "@anthropic-ai/sdk";

// Misma URL que finanzas.js — un solo webhook para leer y escribir.
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL ||
  "https://script.google.com/macros/s/AKfycbyMP4_cyxuB4oCNqh5SGZepnSujePha-tOcVOKbeo9y6BGOxhP-C86dT18JP0r0CvkkLQ/exec";

// ─── Frases que indican CONSULTA (lectura), no registro ───────────
// Deliberadamente amplio: preferimos que una consulta ambigua caiga
// acá y no en finanzas.js (donde el peor caso es un registro fantasma).
const QUERY_TRIGGERS_FINANZAS = [
  /resumen/i,
  /listado/i,
  /list[aá]me/i,
  /cu[aá]nto/i,
  /cu[aá]les?\s+(son|han|es|fueron)/i,
  /qu[eé]\s+(gastos|pagos|ingresos)/i,
  /estado de cuenta/i,
  /saldo\s+(pendiente|del cliente|de\b)/i,
  /cuantos?\s+pagos/i,
  /total\s+de\s+(gastos|pagos|ingresos)/i,
  /historial\s+de\s+(pagos|gastos|ingresos)/i,
  /dame\s+(el|los|las)\s+(resumen|listado|pagos|gastos|ingresos)/i,
  /cu[aá]nto\s+(ha\s+)?(pagado|gastado|debe|cobrado)/i,
  /(muestrame|ensename|enseñame)\s+(los|las)\s+(pagos|gastos|ingresos)/i,
];

export function esConsultaFinanciera(texto) {
  if (!texto) return false;
  return QUERY_TRIGGERS_FINANZAS.some((re) => re.test(texto));
}

// ─── Interpretación con Claude: extraer cliente/proyecto/tipo/fechas ─
async function interpretarConsultaFinanciera(texto) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const hoy = new Date().toLocaleDateString("es-CR", {
    timeZone: "America/Costa_Rica",
    year: "numeric", month: "long", day: "numeric",
  });

  const system = `Sos el intérprete de consultas financieras de Sasha para SS Remodelaciones (Costa Rica). Hoy es ${hoy}.
Un supervisor pregunta por datos YA REGISTRADOS (nunca pide registrar nada nuevo). Respondé SOLO un JSON puro, sin markdown ni backticks:
{"tipo":"pagos"|"gastos"|"ambos","cliente":"nombre o null","proyecto":"nombre o código o null","desde":"YYYY-MM-DD o null","hasta":"YYYY-MM-DD o null"}

REGLAS:
- "pagos"/"ingresos"/"cobros"/"cuánto ha pagado el cliente" → tipo="pagos"
- "gastos"/"cuánto se ha gastado"/"gastos del proyecto" → tipo="gastos"
- Si menciona ambos o no queda claro → tipo="ambos"
- cliente: nombre propio de la persona si la pregunta es sobre un cliente específico
- proyecto: nombre o código de proyecto si la pregunta es sobre un proyecto específico
- Si el mensaje da igual cliente que proyecto (ej. "los pagos de Jose Flores" y Jose Flores también es
  nombre de un proyecto), llená AMBOS campos — el backend hace match flexible contra los dos.
- Si no hay rango de fechas mencionado, desde y hasta = null (trae todo el historial)
- "este mes"/"esta semana"/"este año" → calculá desde/hasta reales en base a hoy, formato YYYY-MM-DD`;

  const r = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    system,
    messages: [{ role: "user", content: texto }],
  });

  const txt = (r.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const a = txt.indexOf("{");
  const b = txt.lastIndexOf("}");
  if (a < 0 || b < 0) return null;

  try {
    return JSON.parse(txt.slice(a, b + 1));
  } catch {
    return null;
  }
}

function formatCRC(n) {
  return `₡${Number(n || 0).toLocaleString("es-CR")}`;
}

function formatFecha(f) {
  if (!f) return "";
  try {
    return new Date(f + "T12:00:00").toLocaleDateString("es-CR", {
      timeZone: "America/Costa_Rica", day: "numeric", month: "short",
    });
  } catch {
    return String(f);
  }
}

async function consultarMovimientos(params) {
  const qs = new URLSearchParams({
    accion: "consulta_movimientos",
    tipo: params.tipo || "ambos",
    cliente: params.cliente || "",
    proyecto: params.proyecto || "",
    desde: params.desde || "",
    hasta: params.hasta || "",
  });

  const url = `${APPS_SCRIPT_URL}${APPS_SCRIPT_URL.includes("?") ? "&" : "?"}${qs.toString()}`;
  const res = await fetch(url);
  const bodyText = await res.text();

  if (!res.ok) {
    throw new Error(`Apps Script HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
  }

  if (/<!DOCTYPE|<html|<head|<body/i.test(bodyText)) {
    throw new Error(
      "el webhook devolvió HTML — probablemente hace falta publicar una NUEVA VERSIÓN de la implementación después de agregar el endpoint de consultas."
    );
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error("Apps Script devolvió una respuesta no válida.");
  }

  if (data.status && data.status !== "ok") {
    throw new Error(data.mensaje || "El ERP no pudo procesar la consulta.");
  }

  return data;
}

function formatearResultado(data, params) {
  const partes = [];
  const sujeto = params.cliente || params.proyecto || "";

  if (params.tipo !== "gastos" && data.pagos) {
    if (data.pagos.length === 0) {
      partes.push(`📭 No encontré pagos${sujeto ? ` de *${sujeto}*` : ""}.`);
    } else {
      const lineas = data.pagos.slice(-15).map(
        (p) => `• ${formatFecha(p.fecha)} — ${formatCRC(p.monto)} — ${p.descripcion || "—"}`
      );
      partes.push(
        [
          `💰 *Pagos${sujeto ? ` de ${sujeto}` : ""}* (${data.pagos.length})`,
          ...lineas,
          data.pagos.length > 15 ? `_...y ${data.pagos.length - 15} más_` : "",
          `*Total: ${formatCRC(data.totalPagos)}*`,
        ].filter(Boolean).join("\n")
      );
    }
  }

  if (params.tipo !== "pagos" && data.gastos) {
    if (data.gastos.length === 0) {
      partes.push(`📭 No encontré gastos${sujeto ? ` de *${sujeto}*` : ""}.`);
    } else {
      const lineas = data.gastos.slice(-15).map(
        (g) => `• ${formatFecha(g.fecha)} — ${formatCRC(g.monto)} — ${g.descripcion || "—"}`
      );
      partes.push(
        [
          `💸 *Gastos${sujeto ? ` de ${sujeto}` : ""}* (${data.gastos.length})`,
          ...lineas,
          data.gastos.length > 15 ? `_...y ${data.gastos.length - 15} más_` : "",
          `*Total: ${formatCRC(data.totalGastos)}*`,
        ].filter(Boolean).join("\n")
      );
    }
  }

  partes.push("_Sasha — Consultas SSR_");
  return partes.join("\n\n");
}

export async function procesarConsultaFinanciera(texto) {
  try {
    const params = await interpretarConsultaFinanciera(texto);

    if (!params) {
      return "⚠️ No entendí bien qué querés consultar. Probá algo como:\n*\"resumen de pagos de Jose Flores\"*\n*\"gastos del proyecto de Miriam\"*";
    }
    if (!params.cliente && !params.proyecto) {
      return "⚠️ ¿De qué cliente o proyecto querés el resumen?";
    }

    const data = await consultarMovimientos(params);
    return formatearResultado(data, params);
  } catch (err) {
    console.error("❌ consultas.js error:", err.message);
    return `❌ No pude traer la información: ${err.message}`;
  }
}
