// ============================================================
// finanzas.js — Módulo financiero para Sasha (SS Remodelaciones)
// v10.5 — FIX DETECCIÓN DE PROYECTO + SUBTIPO SSR (17 agosto 2026):
//        1. CORRECCIÓN DETERMINÍSTICA DE PROYECTO (paso 2.5 de
//           postProcesarMovimiento): cuando el mensaje es lo bastante
//           largo como para saltarse los parsers locales y pasar por
//           Claude, detectarProyectoLocal() ahora vuelve a correr
//           SIEMPRE sobre el texto original como backstop. Si Claude
//           no reconoció el alias del proyecto y devolvió "SSR" por
//           default, pero la detección local sí encuentra un proyecto
//           específico, se sobreescribe — mismo patrón ya usado para
//           moneda y tipo INGRESO/GASTO. Esto es lo que causaba que
//           gastos de un proyecto específico se registraran a nombre
//           de SSR sin ningún aviso.
//        2. CAMPO "subtipo_ssr": para gastos con proyecto_codigo="SSR"
//           se agrega ADMINISTRATIVO / OPERATIVO / MANO_DE_OBRA de forma
//           determinística según categoría, para poder filtrar reportes
//           sin depender de leer la columna categoría a mano.
//
// v10.4 — FIX SSR OPERATIVO + MONEDA COMPROBANTES (14 agosto 2026):
//        1. GASTOS SSR NO LABORALES: si proyecto_codigo="SSR" y NO es Mano de obra,
//           el destino principal pasa a CAJA_GENERAL. Ya no se envía a GASTOS_PROYECTO.
//           Esto alimenta el resumen GASTOS OPERATIVOS SSR sin contaminar costos de obra.
//        2. GASTOS DE PROYECTO REALES: siguen en GASTOS_PROYECTO + CAJA_GENERAL.
//        3. MANO DE OBRA / VALES / PLANILLA: conservan el flujo anterior para no romper
//           BASE_PLANILLA ni las planillas mensuales.
//        4. COMPROBANTES BANCARIOS: cuando Claude leyó monto enviado en CRC desde BAC USD,
//           se respeta moneda=CRC y cuenta=BAC USD. El caption ya no puede forzar USD y
//           multiplicar por el tipo de cambio una segunda vez.
//
// v10.3 — FIX (7 julio 2026, tarde):
//        1. MONTOS CON DECIMALES: "89.535,27" ya se lee como 89535.27
//           (formato tico: miles con punto, decimales con coma).
//           También soporta formato US "89,535.27".
//        2. DESCRIPCIONES SIN LETRAS: ",27", "0,27", "123" ahora cuentan
//           como descripción pobre y se reconstruyen automáticamente
//           ("Categoría — Proyecto/Responsable").
//
// v10.2 — FIX (7 julio 2026):
//        APPS_SCRIPT_URL de respaldo actualizada a la implementación
//        vigente del ERP V13.
//
// v10.1 — FIX (7 julio 2026):
//        moneda forzada por regla local, descripción reparada y
//        ERROR_VALIDACION ya no se confirma como éxito.
//
// v10 — FIX MAYOR (julio 2026):
//   1. INGRESO vs GASTO: corrección determinística post-Claude.
//   2. VALES/PLANILLA a TRABAJADORES.
//   3. DESCRIPCIONES: validación de calidad.
//   4. CUENTA BANCARIA: BAC CRC / BAC USD.
//   5. Payload COMPLETO a Apps Script.
// ============================================================

import Anthropic from "@anthropic-ai/sdk";

// ⚠️ v10.2 — Implementación vigente del ERP V13 (7 jul 2026).
// Si volvés a crear una implementación NUEVA en Apps Script, actualizá la
// variable APPS_SCRIPT_URL en Railway (y este respaldo).
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL ||
  "https://script.google.com/macros/s/AKfycbyMP4_cyxuB4oCNqh5SGZepnSujePha-tOcVOKbeo9y6BGOxhP-C86dT18JP0r0CvkkLQ/exec";

const SHEETS_ID = process.env.SHEETS_ID ||
  "1txCpYo8h30i_GW-aa0M59AwsukgRr3rjlKbgRguz9eA";

// Tipo de cambio USD → CRC.
const TIPO_CAMBIO_USD = Number(process.env.TIPO_CAMBIO_USD) || 530;

// ⚠️ Códigos VERIFICADOS contra la hoja PROYECTOS (julio 2026).
// OJO: el proyecto del panel acanalado de Leonardo es PROY SC1/2026
// (PROY 001/2026 es de Sergio Gonzales Pauta — pintura exterior).
const PROYECTOS = [
  // ── Activos / recientes ─────────────────────────────────────
  {
    codigo: "PROY 060/2026",
    nombre: "María José",
    alias: ["maria jose", "mariajose", "balcon", "balcon maria jose"]
  },
  {
    codigo: "PROY 059/2026",
    nombre: "Rosalía Granados",
    alias: ["rosalia", "granados", "closet rosalia"]
  },
  {
    codigo: "PROY 049/2026",
    nombre: "Laura Víquez",
    alias: ["laura", "viquez", "consultorio laura"]
  },
  {
    codigo: "PROY 045/2026",
    nombre: "Juan Diego",
    alias: ["juan diego", "anexo juan"]
  },
  {
    codigo: "PROY 044/2026",
    nombre: "Karim Sánchez",
    alias: ["karim", "karin", "sanchez"]
  },
  {
    codigo: "PROY 043/2026",
    nombre: "Miriam Ramírez Cordero",
    alias: ["miriam", "ramirez", "enchape miriam", "enchape"]
  },
  {
    codigo: "PROY 037/2026",
    nombre: "Nathalie Alpízar",
    alias: ["nathalie", "natalie", "alpizar", "baño nathalie"]
  },
  {
    codigo: "PROY 033/2026",
    nombre: "Jeannette",
    alias: ["jeannette", "jeanette", "cocina jeannette"]
  },
  {
    codigo: "PROY 030/2026",
    nombre: "Marriott",
    alias: ["marriott", "marriot", "mariot", "hotel marriott", "diversa marriott"]
  },
  {
    codigo: "PROY 028/2026",
    nombre: "Fede y Lore",
    alias: ["fede", "lore", "federico", "banos fede"]
  },
  {
    codigo: "PROY 019/2026",
    nombre: "Christian Alfaro",
    alias: [
      "christian alfaro",
      "alfaro",
      "ventanas",
      "ventaneria",
      "ventanería",
      "proyecto de christian",
      "proyecto de cristian"
    ]
  },
  {
    codigo: "PROY 018/2026",
    nombre: "Anahí Almirón",
    alias: ["anahi", "almiron", "almirón", "salon belleza", "muebles salon"]
  },
  {
    codigo: "PROY 016/2026",
    nombre: "Frank Solano",
    alias: ["frank", "franck", "solano", "baño frank", "bano frank"]
  },
  {
    codigo: "PROY 015/2026",
    nombre: "Guillermo Naranjo",
    alias: ["guillermo", "naranjo", "pintura interior"]
  },
  {
    codigo: "PROY 006/2026",
    nombre: "Jorge Córdoba 2026",
    alias: ["jorge", "cordoba", "chorreadosa", "losa"]
  },
  {
    codigo: "PROY 002/2026",
    nombre: "Kevin Chanto",
    alias: ["kevin", "chanto"]
  },
  {
    codigo: "PROY 001/2026",
    nombre: "Sergio Gonzales Pauta",
    alias: ["sergio", "gonzales pauta", "pintura sergio"]
  },
  {
    codigo: "PROY SC1/2026",
    nombre: "Leonardo Álvarez",
    alias: ["leonardo", "leo", "alvarez", "panel acanalado"]
  },

  // ── Históricos cerrados ─────────────────────────────────────
  {
    codigo: "PROY 166/2025",
    nombre: "César Adrián Montenegro",
    alias: ["cesar", "adrian", "montenegro"]
  },
  {
    codigo: "PROY 154/2025",
    nombre: "Ruth Valverde Aguilar",
    alias: ["ruth", "valverde", "escazu"]
  },
  {
    codigo: "PROY 151/2025",
    nombre: "Daniel Marín Ortega",
    alias: ["daniel", "marin", "cocina daniel"]
  },
  {
    codigo: "PROY 022/2025",
    nombre: "Nathalie Alpízar 2025",
    alias: ["nathalie 2025"]
  },
  {
    codigo: "PROY 015/2025",
    nombre: "Fede y Lore 2025",
    alias: ["lore 2025"]
  },
  {
    codigo: "PROY 008/2025",
    nombre: "Jorge Córdoba 2025",
    alias: ["cordoba 2025"]
  },
  {
    codigo: "PROY 004/2025",
    nombre: "Franxi Solano",
    alias: ["franxi"]
  }
];

// ⚠️ TRABAJADORES — sincronizado con la hoja TRABAJADORES.
const TRABAJADORES = [
  { nombre: "Fernando Chevez Sandino", alias: ["fernando", "fercho"] },
  { nombre: "Melvin Zúñiga",           alias: ["melvin", "cuñis", "cunis"] },
  { nombre: "Christhian Zacarias",     alias: ["christhian", "christian", "cristian", "chirstian"] },
  { nombre: "Mauricio",                alias: ["mauricio", "chollina"] },
  { nombre: "Yader Fonseca",           alias: ["yader"] },
  { nombre: "Darwin Guillón",          alias: ["darwin"] },
  { nombre: "Brayan Solís",            alias: ["brayan", "bryan"] },
  { nombre: "Maribel",                 alias: ["maribel"] },
  { nombre: "Victor Guillón",          alias: ["victor", "vic"] },
  { nombre: "Eithan Tames Salazar",    alias: ["eithan"] },
  { nombre: "Kenny",                   alias: ["kenny"] },
  { nombre: "Enrique",                 alias: ["enrique"] },
  { nombre: "Roilan",                  alias: ["roilan"] }
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
  "subcontrato","subcontratista","descuenta","desconta","rebaja","saca",
  "materiales","herramientas","gasolina","combustible","diesel","diésel",
  "transporte","almuerzo","comida","alimentacion",
  "ferretería","ferreteria","epa","construplaza",
  "bodega","inventario","mano de obra",
  "alquiler","contabilidad","seguro","luz","electricidad","agua","internet",
  "colones","mil colones","millones","efectivo","transferencia","sinpe","tarjeta",
  "usd","dolar","dolares","dólar","dólares"
];
// ─── Helpers de fecha ────────────────────────────────────────
const TODAY = () => {
  const cr = new Date(
    new Date().toLocaleString("en-US", {
      timeZone: "America/Costa_Rica"
    })
  );

  return cr.getFullYear() + "-"
    + String(cr.getMonth() + 1).padStart(2, "0") + "-"
    + String(cr.getDate()).padStart(2, "0");
};

const getMesActual = () => {
  const meses = [
    "ENERO",
    "FEBRERO",
    "MARZO",
    "ABRIL",
    "MAYO",
    "JUNIO",
    "JULIO",
    "AGOSTO",
    "SEPTIEMBRE",
    "OCTUBRE",
    "NOVIEMBRE",
    "DICIEMBRE"
  ];

  const cr = new Date(
    new Date().toLocaleString("en-US", {
      timeZone: "America/Costa_Rica"
    })
  );

  return meses[cr.getMonth()];
};

const getDiaSemana = () => {
  const dias = [
    "",
    "LUN",
    "MAR",
    "MIÉ",
    "JUE",
    "VIE",
    "SÁB"
  ];

  const cr = new Date(
    new Date().toLocaleString("en-US", {
      timeZone: "America/Costa_Rica"
    })
  );

  const d = cr.getDay();

  return d === 0 ? "DOM" : dias[d];
};

const getSemanaDelMes = () => {
  const cr = new Date(
    new Date().toLocaleString("en-US", {
      timeZone: "America/Costa_Rica"
    })
  );

  return Math.ceil(cr.getDate() / 7);
};


// ─── Normalización ───────────────────────────────────────────
function norm(t) {
  return String(t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}


// ─── Detección de trabajador ─────────────────────────────────
function detectarTrabajador(texto) {

  const t = norm(texto);

  for (const w of TRABAJADORES) {

    for (const a of w.alias) {

      if (new RegExp(`\\b${a}\\b`, "i").test(t)) {

        return {
          ...w,
          aliasMatch: a
        };

      }

    }

  }

  return null;
}


// ¿El mensaje es un vale / pago de planilla / adelanto a un trabajador?
function esContextoPlanilla(texto) {

  const t = norm(texto);

  return /\b(vale|planilla|adelanto|quincena|salario|sueldo|semana)\b/.test(t);

}


// Trabajador mencionado justo después de
// vale/planilla/adelanto/pago ... (para|de|a)
function trabajadorEnContextoPlanilla(texto) {

  const t = norm(texto);

  const m = t.match(
    /\b(?:vale|planilla|adelanto|quincena|salario|sueldo|pago)\b[^.]{0,40}?\b(?:para|de|a|al)\s+([a-z]+(?:\s+[a-z]+)?)/
  );

  if (!m) return null;

  return detectarTrabajador(m[1]);

}


// ─── Detección de moneda ─────────────────────────────────────
function detectarMonedaLocal(texto) {

  const t = norm(texto);

  if (
    /\busd\b/.test(t) ||
    /\bdolar(es)?\b/.test(t) ||
    /\$\s*\d/.test(t) ||
    /\d\s*\$/.test(t)
  ) {

    return "USD";

  }

  return "CRC";
}


function cuentaSegunMoneda(moneda) {

  return moneda === "USD"
    ? "BAC USD"
    : "BAC CRC";

}


// ─── Parser local de montos CR ───────────────────────────────
function parseMontoFinancieroLocal(valor) {

  if (
    valor === null ||
    valor === undefined
  ) {
    return 0;
  }

  let txt = norm(valor)
    .replace(/₡/g, "")
    .replace(/\$/g, "")
    .replace(/\busd\b/g, "")
    .replace(/\bdolar(es)?\b/g, "")
    .replace(/\bcolones?\b/g, "")
    .trim();


  if (!txt) return 0;


  // "medio millón"
  if (/\bmedio\s+millon\b/.test(txt)) {

    return 500000;

  }


  // ─────────────────────────────────────────────
  // MILLONES
  // Ej:
  // 1 millón
  // 1.5 millones
  // 1,5 millones
  // ─────────────────────────────────────────────

  let m = txt.match(
    /(\d+(?:[.,]\d+)?)\s*(?:millones?|millon)\b/
  );

  if (m) {

    const n = Number(
      m[1].replace(",", ".")
    );

    return isNaN(n)
      ? 0
      : Math.round(n * 1000000);

  }


  // ─────────────────────────────────────────────
  // MILES
  // Ej:
  // 50 mil
  // 25k
  // 1.5 mil
  // ─────────────────────────────────────────────

  m = txt.match(
    /(\d+(?:[.,]\d+)?)\s*(?:mil|k)\b/
  );

  if (m) {

    const n = Number(
      m[1].replace(",", ".")
    );

    return isNaN(n)
      ? 0
      : Math.round(n * 1000);

  }


  // ─────────────────────────────────────────────
  // FORMATO TICO
  //
  // Miles con punto
  // Decimales con coma
  //
  // 89.535,27
  // =
  // 89535.27
  // ─────────────────────────────────────────────

  m = txt.match(
    /\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?/
  );

  if (m) {

    return Number(
      m[0]
        .replace(/\./g, "")
        .replace(",", ".")
    ) || 0;

  }


  // ─────────────────────────────────────────────
  // FORMATO US
  //
  // Miles con coma
  // Decimales con punto
  //
  // 89,535.27
  // =
  // 89535.27
  // ─────────────────────────────────────────────

  m = txt.match(
    /\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?/
  );

  if (m) {

    return Number(
      m[0].replace(/,/g, "")
    ) || 0;

  }


  // ─────────────────────────────────────────────
  // Miles sin decimales
  //
  // 89.535
  // 89,535
  // ─────────────────────────────────────────────

  m = txt.match(
    /\d{1,3}(?:[.,]\d{3})+/
  );

  if (m) {

    return Number(
      m[0].replace(/[.,]/g, "")
    ) || 0;

  }


  // ─────────────────────────────────────────────
  // Número simple
  // ─────────────────────────────────────────────

  m = txt.match(
    /\d+(?:[.,]\d+)?/
  );

  if (m) {

    return Number(
      m[0].replace(",", ".")
    ) || 0;

  }


  return 0;
}
// ─── Extracción local del monto ───────────────────────────────
function extraerMontoLocal(texto) {

  const t = norm(texto);

  const patrones = [
    /(\d+(?:[.,]\d+)?)\s*(?:millones?|millon)\b/,

    // v10.3 — capturan el número COMPLETO incluyendo decimales
    // ("89.535,27"), para que al limpiar la descripción
    // no quede un ",27" huérfano.
    /\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?/,
    /\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?/,
    /\d{1,3}(?:[.,]\d{3})+/,
    /\d{4,}/,
    /\d+(?:[.,]\d+)?/
  ];

  for (const p of patrones) {

    const m = t.match(p);

    if (m) {

      return {
        raw: m[0],
        monto: parseMontoFinancieroLocal(m[0])
      };

    }

  }

  return {
    raw: "",
    monto: 0
  };
}


// ─── Clasificación local del gasto ────────────────────────────
function categorizarGastoLocal(desc) {

  const t = norm(desc);

  if (
    /gasolina|combustible|diesel|aceite|pick up|pickup|vehiculo|transporte/.test(t)
  ) {
    return "Transporte";
  }

  if (
    /material|ferreter|epa|construplaza|lagar|colono/.test(t)
  ) {
    return "Material";
  }

  if (
    /comida|almuerzo|desayuno|cena|alimentaci/.test(t)
  ) {
    return "Alimentación";
  }

  if (
    /herramient|equipo|maquina/.test(t)
  ) {
    return "Herramienta";
  }

  if (
    /subcontrat|contratista/.test(t)
  ) {
    return "Subcontrato";
  }

  if (
    /vale|planilla|quincena|salario|sueldo/.test(t)
  ) {
    return "Mano de obra";
  }

  if (
    /seguro|ccss|poliza/.test(t)
  ) {
    return "Seguros";
  }

  if (
    /internet|luz|electricidad|agua|telefono/.test(t)
  ) {
    return "Servicios";
  }

  return "Gasto";
}


// ─── Destino contable determinístico v10.4 ───────────────────
//
// SSR es un CENTRO DE COSTO operativo, no un proyecto.
//
// - Gasto no laboral SSR
//      → CAJA_GENERAL únicamente.
//
// - Gasto de proyecto real
//      → GASTOS_PROYECTO + CAJA_GENERAL.
//
// - Mano de obra / vale
//      → conserva el flujo anterior para que Apps Script
//        mantenga la conciliación con BASE_PLANILLA.
//
// - Subcontratos e ingresos
//      → conservan sus pestañas especializadas.
//
function aplicarDestinoContableSSR(out) {

  const codigo =
    String(
      out.proyecto_codigo || "SSR"
    )
      .trim()
      .toUpperCase();


  const categoria =
    norm(
      out.categoria || ""
    );


  const principalActual =
    String(
      out.pestaña_principal || ""
    )
      .trim()
      .toUpperCase();


  // ─────────────────────────────────────────────
  // PLANILLA DE HORAS
  // ─────────────────────────────────────────────

  const esPlanillaHoras =

    out.tipo === "PLANILLA" ||

    /^PLANILLA_/i.test(
      principalActual
    );


  if (esPlanillaHoras) {

    return out;

  }


  // ─────────────────────────────────────────────
  // INGRESOS
  // ─────────────────────────────────────────────

  if (
    out.tipo === "INGRESO"
  ) {

    out.pestaña_principal =
      "INGRESOS_CLIENTES";

    return out;

  }


  // ─────────────────────────────────────────────
  // SUBCONTRATOS
  // ─────────────────────────────────────────────

  const esSubcontrato =

    principalActual === "SUBCONTRATOS" ||

    categoria === "subcontrato";


  if (esSubcontrato) {

    out.pestaña_principal =
      "SUBCONTRATOS";

    return out;

  }


  // ─────────────────────────────────────────────
  // GASTOS
  // ─────────────────────────────────────────────

  if (
    out.tipo === "GASTO"
  ) {

    const esManoObra =

      categoria === "mano de obra" ||

      /\b(vale|planilla|quincena|salario|sueldo|jornal)\b/
        .test(
          norm(
            out.descripcion || ""
          )
        );


    // IMPORTANTE:
    //
    // No cambiamos aquí el flujo histórico de
    // mano de obra / vales.
    //
    // El Apps Script actual ya sabe conciliarlos
    // con BASE_PLANILLA.

    if (esManoObra) {

      if (
        !out.pestaña_principal ||

        principalActual ===
          "INGRESOS_CLIENTES" ||

        principalActual ===
          "CAJA_GENERAL"
      ) {

        out.pestaña_principal =
          "GASTOS_PROYECTO";

      }

      out.subtipo_ssr =
        "MANO_DE_OBRA";

      return out;

    }


    // ==========================================================
    // REGLA CRÍTICA V10.4
    //
    // SSR NO ES UN PROYECTO.
    //
    // Un gasto administrativo u operativo general
    // de SS Remodelaciones se registra únicamente
    // en CAJA_GENERAL.
    //
    // NO entra en GASTOS_PROYECTO.
    // ==========================================================

    if (
      codigo === "SSR"
    ) {

      out.proyecto_codigo =
        "SSR";

      out.proyecto =
        "SS Remodelaciones";

      out.pestaña_principal =
        "CAJA_GENERAL";


      // ------------------------------------------------------
      // v10.5 — SUBTIPO SSR (ADMINISTRATIVO vs OPERATIVO)
      //
      // Antes solo existía la categoría libre. Ahora se agrega
      // un campo determinístico que permite filtrar/reportar
      // "Gastos Administrativos SSR" vs "Gastos Operativos SSR"
      // sin depender de leer la columna categoría a mano.
      // ------------------------------------------------------

      const CATEGORIAS_ADMINISTRATIVAS = new Set([
        "servicios",
        "seguros",
        "alquiler",
        "contabilidad"
      ]);

      out.subtipo_ssr =
        CATEGORIAS_ADMINISTRATIVAS.has(categoria)
          ? "ADMINISTRATIVO"
          : "OPERATIVO";


      out.observaciones = [

        out.observaciones || "",

        "Gasto operativo/administrativo SSR — no imputar a proyecto"

      ]
        .filter(Boolean)
        .join(" | ");

    } else {

      // Proyecto real:
      //
      // PROY XXX/YYYY
      //
      // Sí debe afectar el costo del proyecto.

      out.pestaña_principal =
        "GASTOS_PROYECTO";

      out.subtipo_ssr = null;

    }

  }


  return out;
}


// ─── Levenshtein para typos ──────────────────────────────────
function levenshtein(a, b) {

  if (a === b) return 0;

  const al = a.length;
  const bl = b.length;

  if (al === 0) return bl;
  if (bl === 0) return al;


  const dp =
    Array.from(
      {
        length: al + 1
      },
      (_, i) => [
        i,
        ...Array(bl).fill(0)
      ]
    );


  for (
    let j = 0;
    j <= bl;
    j++
  ) {

    dp[0][j] = j;

  }


  for (
    let i = 1;
    i <= al;
    i++
  ) {

    for (
      let j = 1;
      j <= bl;
      j++
    ) {

      dp[i][j] =

        a[i - 1] === b[j - 1]

          ? dp[i - 1][j - 1]

          : 1 + Math.min(

              dp[i - 1][j],

              dp[i][j - 1],

              dp[i - 1][j - 1]

            );

    }

  }


  return dp[al][bl];
}


// ─── Detección de proyecto (con guardia de trabajadores) ─────
//
// Si el nombre viene en contexto de planilla/vale
// y coincide con un TRABAJADOR,
// ese nombre NO cuenta para detectar proyecto.
//
function detectarProyectoLocal(texto) {

  let t =
    norm(texto);


  const trabPlanilla =
    trabajadorEnContextoPlanilla(
      texto
    );


  if (trabPlanilla) {

    // borrar el alias del trabajador del texto
    // antes de buscar proyecto

    t =
      t.replace(

        new RegExp(
          `\\b${trabPlanilla.aliasMatch}\\b`,
          "gi"
        ),

        " "

      );

  }


  const palabras =

    t
      .split(/[^a-z0-9]+/)
      .filter(Boolean);


  // ─────────────────────────────────────────────
  // Coincidencia directa
  // ─────────────────────────────────────────────

  for (const p of PROYECTOS) {

    const nombre =
      norm(p.nombre);


    const aliases =

      (p.alias || [])
        .map(norm);


    if (

      t.includes(nombre) ||

      aliases.some(
        a =>
          a &&
          t.includes(a)
      )

    ) {

      return p;

    }

  }


  // ─────────────────────────────────────────────
  // Coincidencia aproximada para typos
  // ─────────────────────────────────────────────

  for (const p of PROYECTOS) {

    const aliases =

      (p.alias || [])
        .map(norm);


    for (const alias of aliases) {

      if (
        alias.length < 4 ||
        alias.includes(" ")
      ) {

        continue;

      }


      for (
        const palabra of palabras
      ) {

        if (
          palabra.length < 4
        ) {

          continue;

        }


        const dist =
          levenshtein(
            alias,
            palabra
          );


        if (

          dist <=
          Math.max(
            1,
            Math.floor(
              alias.length / 5
            )
          )

        ) {

          return p;

        }

      }

    }

  }


  // ==========================================================
  // NO SE ENCONTRÓ PROYECTO
  //
  // SSR funciona como centro de costo general.
  // ==========================================================

  return {

    codigo:
      "SSR",

    nombre:
      "SS Remodelaciones"

  };
}
// ─── Clasificación determinística INGRESO / GASTO ────────────
// Devuelve "INGRESO", "GASTO" o null (ambiguo).
function clasificarTipoLocal(texto) {
  const t = norm(texto);

  const ingreso =
    /\b(ingreso|ingresos|me pagaron|nos pagaron|pagaron|cobre|cobro de|cobramos|abono del cliente|abonaron|deposito recibido|depositaron|transferencia recibida|recibi|recibimos)\b/.test(t);

  const gasto =
    /\b(gasto|gaste|pague|compre|compra de|descuenta|desconta|rebaja|saca|vale|salida)\b/.test(t)
    || /\bpago (?:de|a|al|del|para)\b/.test(t);

  if (ingreso && !gasto) return "INGRESO";

  if (gasto && !ingreso) return "GASTO";

  if (ingreso && gasto) {
    // "ingreso" gana: nadie dice "ingreso" para registrar un gasto
    if (/\bingresos?\b/.test(t)) return "INGRESO";

    return null;
  }

  return null;
}


// ─── Calidad de descripción ──────────────────────────────────
const CONECTORES_SIN_CONTENIDO = new Set([
  "el","la","los","las","un","una","unos","unas","de","del","al","a","en",
  "para","por","con","y","o","que","su","sus","lo","le","se","es","son",
  "nombre","monto","proyecto","cliente","srr","ssr",
]);


function descripcionEsPobre(desc) {

  if (!desc) return true;

  // "Sin descripción" era la vía de escape favorita de Claude y el Apps
  // Script la rechaza (ERROR_VALIDACION) — se repara ANTES de enviar.
  if (
    /^sin\s+descripci/i.test(
      String(desc).trim()
    )
  ) {
    return true;
  }


  // v10.3 — sin ninguna letra
  // ",27", "0,27", "123" no son descripciones.
  if (
    !/[a-z]/i.test(
      norm(desc)
    )
  ) {
    return true;
  }


  const palabras =
    norm(desc)
      .split(/\s+/)
      .filter(
        w =>
          w.length > 1 &&
          !CONECTORES_SIN_CONTENIDO.has(w)
      );


  if (
    palabras.length < 1
  ) {
    return true;
  }


  // Termina en preposición/artículo colgante
  // → quedó cortada.
  if (
    /\b(de|del|para|por|en|al|a|el|la|un|una|nombre)\s*\.?$/i
      .test(
        String(desc).trim()
      )
  ) {
    return true;
  }


  return false;
}


function repararDescripcion(mov, textoOriginal) {

  if (
    !descripcionEsPobre(
      mov.descripcion
    )
  ) {
    return mov.descripcion;
  }


  const partes = [];


  if (
    mov.categoria &&
    mov.categoria !== "Gasto"
  ) {

    partes.push(
      mov.categoria
    );

  } else {

    partes.push(
      mov.tipo === "INGRESO"
        ? "Ingreso"
        : "Gasto"
    );

  }


  if (mov.responsable) {

    partes.push(
      mov.responsable
    );

  } else if (mov.cliente) {

    partes.push(
      mov.cliente
    );

  } else if (
    mov.proyecto &&
    mov.proyecto !== "SS Remodelaciones"
  ) {

    partes.push(
      mov.proyecto
    );

  } else {

    // Último recurso:
    // primeras palabras con contenido
    // del mensaje original.

    const contenido =
      norm(textoOriginal)
        .split(/\s+/)
        .filter(
          w =>
            w.length > 3 &&
            !CONECTORES_SIN_CONTENIDO.has(w) &&
            !/^\d/.test(w)
        )
        .slice(0, 4);


    if (
      contenido.length
    ) {

      partes.push(
        contenido.join(" ")
      );

    }

  }


  return partes.join(" — ");
}


// ─── Construcción local de descripción ───────────────────────
function construirDescripcionLocal(
  original,
  raw,
  proyectoTextoExtraido
) {

  let desc = original;


  if (raw) {

    desc =
      desc
        .replace(
          new RegExp(
            raw.replace(
              /[.*+?^${}()|[\]\\]/g,
              "\\$&"
            ),
            "i"
          ),
          ""
        )
        .trim();

  }


  desc =
    desc

      .replace(
        /\busd\b/ig,
        ""
      )

      .replace(
        /\bdolar(es)?\b/ig,
        ""
      )

      .replace(
        /\$/g,
        ""
      )

      .replace(
        /^(apunta|anota|anotame|registra|registrame|carga|cargame|descuenta|desconta|rebaja|saca|gasto|pago|pague|compr[eé]|compra|ingreso|me pagaron|pagaron|abono|abonaron)\b\s*/i,
        ""
      )

      .replace(
        /\b(el|un|la|una)\s+(pago|gasto|ingreso|abono|adelanto)\s+de\b/ig,
        ""
      )

      .replace(
        /\b(pague|pago|gasto|ingreso|abono|adelanto)\s+de\b/ig,
        ""
      )

      .replace(
        /\ben caja general\b/ig,
        ""
      )

      .replace(
        /\bcolones?\b/ig,
        ""
      )

      .trim();


  if (
    proyectoTextoExtraido
  ) {

    const re =
      new RegExp(

        "\\s*(?:,)?\\s*(?:para|en|de|del|al|el|la)?\\s*(?:para|en|de|del|al|el|la)?\\s*(?:proyecto|obra|cliente)\\s+(?:de\\s+|del\\s+)?" +

        proyectoTextoExtraido.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        ) +

        "\\b.*$",

        "i"

      );


    desc =
      desc
        .replace(
          re,
          ""
        )
        .trim();

  }


  let prev;


  do {

    prev = desc;


    desc =
      desc

        .replace(
          /^(de|del|por|para|en|al|a la|a el|y)\s+/i,
          ""
        )

        .replace(
          /\s+(de|del|por|para|en|al|a la|a el|y)$/i,
          ""
        )

        .replace(
          /\s{2,}/g,
          " "
        )

        .replace(
          /^[\s,.-]+|[\s,.-]+$/g,
          ""
        )

        .trim();


  } while (
    desc !== prev &&
    desc.length > 0
  );


  if (
    descripcionEsPobre(desc)
  ) {
    return null;
  }


  return desc;
}


// ─── Filtro de comandos financieros ──────────────────────────
function esComandoFinanciero(texto) {

  if (!texto) {
    return false;
  }


  const t =
    norm(texto);


  return KEYWORDS_FINANZAS.some(
    kw =>
      t.includes(
        norm(kw)
      )
  );

}


// ─── Post-procesamiento común ────────────────────────────────
// moneda + cuenta + tipo + descripción + destino contable
function postProcesarMovimiento(
  m,
  textoOriginal,
  opciones = {}
) {

  // ==========================================================
  // MONEDA
  // ==========================================================

  let moneda =
    m.moneda === "USD"
      ? "USD"
      : "CRC";


  const monedaLocal =
    detectarMonedaLocal(
      textoOriginal
    );


  let monedaCorregida =
    false;


  // En comprobantes bancarios Claude ve la imagen completa
  // y distingue:
  //
  // "Monto debitado" → puede ser USD
  // "Monto enviado"  → puede ser CRC
  //
  // Si respetarMonedaModelo=true,
  // NO sobreescribimos esa decisión con el caption.

  if (
    !opciones.respetarMonedaModelo &&
    monedaLocal === "USD" &&
    moneda !== "USD"
  ) {

    moneda =
      "USD";

    monedaCorregida =
      true;

  }


  const montoOriginal =
    Number(
      m.monto_original ??
      m.monto
    ) || 0;


  const montoCRC =

    moneda === "USD"

      ? Math.round(
          montoOriginal *
          TIPO_CAMBIO_USD
        )

      : montoOriginal;


  const out = {

    ...m,

    moneda,

    monto:
      montoCRC,

    monto_original:
      montoOriginal,

    // Si la moneda fue corregida localmente,
    // la cuenta del modelo ya no vale.
    cuenta:
      monedaCorregida

        ? cuentaSegunMoneda(
            moneda
          )

        : (
            m.cuenta ||
            cuentaSegunMoneda(
              moneda
            )
          ),

    tipo_cambio:
      moneda === "USD"
        ? TIPO_CAMBIO_USD
        : 1

  };


  if (
    monedaCorregida
  ) {

    out.observaciones = [

      out.observaciones || "",

      "Moneda corregida a USD por regla local"

    ]
      .filter(Boolean)
      .join(" | ");

  }


  // ==========================================================
  // 1. FORZAR TIPO INGRESO/GASTO
  // ==========================================================

  if (
    out.tipo !== "PLANILLA"
  ) {

    const tipoLocal =
      clasificarTipoLocal(
        textoOriginal
      );


    if (
      tipoLocal &&
      tipoLocal !== out.tipo
    ) {

      out.tipo =
        tipoLocal;


      out.observaciones = [

        out.observaciones || "",

        "Tipo corregido por regla local"

      ]
        .filter(Boolean)
        .join(" | ");

    }


    if (
      out.tipo === "INGRESO"
    ) {

      out["pestaña_principal"] =
        "INGRESOS_CLIENTES";


      out.categoria =

        out.categoria &&
        /ingreso/i.test(
          out.categoria
        )

          ? out.categoria

          : "Ingreso cliente";


    } else if (

      out.tipo === "GASTO" &&

      out["pestaña_principal"] ===
        "INGRESOS_CLIENTES"

    ) {

      out["pestaña_principal"] =
        "GASTOS_PROYECTO";

    }

  }


  // ==========================================================
  // 2. GUARDIA DE TRABAJADORES
  // ==========================================================

  const trab =
    trabajadorEnContextoPlanilla(
      textoOriginal
    );


  if (
    trab &&
    out.tipo === "GASTO"
  ) {

    out.responsable =
      out.responsable ||
      trab.nombre;


    out.categoria =
      "Mano de obra";


    // Si el proyecto detectado salió SOLO por
    // el nombre del trabajador → SSR.

    const proySinTrab =
      detectarProyectoLocal(
        textoOriginal
      );


    out.proyecto_codigo =
      proySinTrab.codigo;


    out.proyecto =
      proySinTrab.nombre;


    if (
      !out.descripcion ||
      descripcionEsPobre(
        out.descripcion
      ) ||
      norm(
        out.descripcion
      ) === "vale"
    ) {

      out.descripcion =
        `Vale planilla ${trab.nombre.split(" ")[0]}`;

    }

  }


  // ==========================================================
  // 2.5 CORRECCIÓN DETERMINÍSTICA DE PROYECTO — v10.5
  //
  // PROBLEMA QUE RESUELVE:
  // Claude decidía "proyecto_codigo" libremente cuando el mensaje
  // era demasiado largo para los parsers locales (>11 palabras,
  // dictado natural). Si no reconocía bien el alias del proyecto
  // (fraseo raro, ruido de Whisper, orden de palabras distinto al
  // listado en el prompt), caía en el default "SSR" — en silencio,
  // sin error visible. Resultado: gastos de proyectos específicos
  // terminaban mezclados en el centro de costo general SSR.
  //
  // FIX:
  // detectarProyectoLocal() ya es la fuente de verdad confiable
  // que usan los otros dos parsers (crudo y natural corto). Ahora
  // se corre SIEMPRE sobre el texto original (salvo que el guardia
  // de trabajador ya haya resuelto el proyecto en el paso 2) y, si
  // encuentra un proyecto específico que Claude no detectó, se
  // sobreescribe el resultado del modelo — mismo patrón que ya se
  // usa para moneda y tipo INGRESO/GASTO más arriba.
  // ==========================================================

  if (
    !trab &&
    out.tipo !== "PLANILLA"
  ) {

    const proyectoLocal =
      detectarProyectoLocal(
        textoOriginal
      );


    const codigoModelo =
      String(
        out.proyecto_codigo || "SSR"
      )
        .trim()
        .toUpperCase();


    const codigoLocal =
      String(
        proyectoLocal.codigo || "SSR"
      )
        .trim()
        .toUpperCase();


    // Solo corregimos cuando la detección local SÍ encontró un
    // proyecto específico (no "SSR") y difiere de lo que devolvió
    // Claude. Si la detección local también da "SSR", no forzamos
    // nada: puede que el mensaje genuinamente no mencione proyecto,
    // y ahí sí confiamos en el criterio de Claude (p. ej. reconoció
    // el proyecto por contexto de la conversación, no solo del texto
    // suelto).
    if (
      codigoLocal !== "SSR" &&
      codigoLocal !== codigoModelo
    ) {

      out.proyecto_codigo =
        proyectoLocal.codigo;

      out.proyecto =
        proyectoLocal.nombre;


      out.observaciones = [

        out.observaciones || "",

        `Proyecto corregido por regla local (modelo devolvió "${codigoModelo}")`

      ]
        .filter(Boolean)
        .join(" | ");

    }

  }


  // ==========================================================
  // 3. DESTINO CONTABLE DETERMINÍSTICO
  //
  // Aquí vuelve a entrar la regla:
  //
  // SSR operativo/administrativo
  // → CAJA_GENERAL
  //
  // Proyecto real
  // → GASTOS_PROYECTO
  // ==========================================================

  aplicarDestinoContableSSR(
    out
  );


  // ==========================================================
  // 4. REPARAR DESCRIPCIÓN POBRE
  // ==========================================================

  out.descripcion =
    repararDescripcion(
      out,
      textoOriginal
    );


  // ==========================================================
  // 5. OBSERVACIONES DE MONEDA
  // ==========================================================

  if (
    moneda === "USD"
  ) {

    const nota =
      `Monto original: $${montoOriginal} USD (TC ₡${TIPO_CAMBIO_USD})`;


    out.observaciones =

      out.observaciones

        ? `${nota} | ${out.observaciones}`

        : nota;

  }


  // ==========================================================
  // 6. GARANTÍA CAJA_GENERAL — FIX v10.4
  //
  // Todo movimiento financiero que no sea
  // PLANILLA DE HORAS debe afectar CAJA_GENERAL.
  //
  // Si CAJA_GENERAL ya es principal,
  // NO se repite como adicional.
  // ==========================================================

  const esPlanillaHoras =

    out.tipo === "PLANILLA" ||

    /^PLANILLA_/i.test(
      out["pestaña_principal"] || ""
    );


  if (
    !esPlanillaHoras
  ) {

    const adicionales =
      new Set(

        Array.isArray(
          out.pestanas_adicionales
        )

          ? out.pestanas_adicionales

          : []

      );


    if (
      String(
        out.pestaña_principal || ""
      )
        .toUpperCase() ===
        "CAJA_GENERAL"
    ) {

      adicionales.delete(
        "CAJA_GENERAL"
      );

    } else {

      adicionales.add(
        "CAJA_GENERAL"
      );

    }


    out.pestanas_adicionales =
      Array.from(
        adicionales
      );

  }


  return out;
}
// ─── System prompt para Claude ───────────────────────────────
const buildSystemPrompt = () => {
  const proyectosCtx = PROYECTOS
    .map(p => `- ${p.codigo}: ${p.nombre} (alias: ${p.alias.join(", ")})`)
    .join("\n");

  const trabajadoresCtx = TRABAJADORES
    .map(w => `- ${w.nombre} (alias: ${w.alias.join(", ")})`)
    .join("\n");

  const mesActual   = getMesActual();
  const diaSemana   = getDiaSemana();
  const numSemana   = getSemanaDelMes();
  const planillaMes = `PLANILLA_${mesActual}`;

  return `Sos el agente financiero IA de SS Remodelaciones, empresa costarricense de construcción.

PROYECTOS (activos y cerrados — ambos reciben gastos):
${proyectosCtx}

TRABAJADORES DE PLANILLA (NO son proyectos ni clientes):
${trabajadoresCtx}

CONTEXTO HOY: ${TODAY()} | Día: ${diaSemana} | Semana del mes: ${numSemana} | Mes planilla: ${planillaMes}

REGLAS DE INTERPRETACIÓN:
- NÚMEROS COSTARRICENSES: punto = separador de miles → "4.500"=4500, "1.200.000"=1200000
- "X mil" = X*1000. "medio millón" = 500000
- MONEDA: si el mensaje menciona "usd", "dólares", "dolares" o "$" antes/después del número,
  el monto está en USD. Devolvé "moneda": "USD" y "monto" en USD (NO conviertas).
  Si no se menciona moneda extranjera, asumí colones y "moneda": "CRC".
- Sin fecha = hoy: ${TODAY()}
- Detectá proyecto por nombre o alias EN CUALQUIER PARTE del mensaje, incluso con errores
  de tipeo leves. Si no encontrás el proyecto por ningún alias → proyecto_codigo = "SSR".
  IMPORTANTE: tu detección de proyecto pasa por una verificación determinística después —
  si te equivocás, el sistema lo corrige, pero hacé tu mejor esfuerzo igual.
- Gastos operativos/administrativos sin proyecto claro → proyecto_codigo = "SSR" y pestaña_principal="CAJA_GENERAL".
- SSR es centro de costo, NO proyecto. Un gasto SSR no laboral NUNCA va a GASTOS_PROYECTO.
- Gasto con PROY XXX/YYYY → pestaña_principal="GASTOS_PROYECTO" y además CAJA_GENERAL.
- SIEMPRE incluir "CAJA_GENERAL" en pestanas_adicionales salvo si CAJA_GENERAL ya es principal o si es planilla de horas)

REGLA CRÍTICA #1 — INGRESO vs GASTO (la regla MÁS importante):
Si el mensaje contiene la palabra "ingreso", o describe dinero que ENTRA a SS
Remodelaciones ("me pagaron", "cobré", "el cliente abonó", "pago de visita técnica
DEL cliente", "adelanto del cliente"), es SIEMPRE tipo="INGRESO" con
pestaña_principal="INGRESOS_CLIENTES". NUNCA lo marques como GASTO.
"A nombre de SSR" indica el PROYECTO al que se asocia — NO cambia ingreso/gasto.
Ejemplo obligatorio:
  "Apunta el ingreso de 25.000 de José Guillermo Flores por visita técnica a nombre de SSR"
  → {"tipo":"INGRESO","monto":25000,"cliente":"José Guillermo Flores",
     "descripcion":"Visita técnica — cobro","proyecto_codigo":"SSR",
     "pestaña_principal":"INGRESOS_CLIENTES"}

REGLA CRÍTICA #2 — VALES Y PLANILLA A TRABAJADORES:
Si el mensaje dice "vale para [nombre]", "pago de planilla a [nombre]", "adelanto a
[nombre]" y [nombre] está en la lista de TRABAJADORES, entonces:
- Es un GASTO, categoria="Mano de obra", responsable=[nombre completo del trabajador]
- El proyecto es "SSR" SALVO que el mensaje mencione EXPLÍCITAMENTE otro proyecto
  ("vale para Christhian en el proyecto de Miriam" → PROY 043/2026).
- El nombre del trabajador NUNCA sirve para detectar el proyecto. "Vale para
  Christhian" NO es el proyecto del cliente Christian Alfaro.
- descripcion = "Vale planilla [nombre]" o "Pago planilla [nombre]"

REGLA CRÍTICA #3 — CALIDAD DE DESCRIPCIÓN:
La descripción debe ser un resumen claro de 3-8 palabras del MOTIVO ("Transporte
operarios Marriott", "Materiales gypsum", "Vale planilla Fernando"). PROHIBIDO
devolver fragmentos sueltos como "el", "nombre", "Yader en el". Si dudás,
construíla como "[Categoría] [persona o proyecto]".

REGLAS PARA PLANILLA (cuando alguien dice "X trabajó N horas"):
- tipo = "PLANILLA"
- pestaña_principal = "${planillaMes}"
- pestanas_adicionales = ["BASE_PLANILLA"] (sin CAJA_GENERAL, el monto se calcula después)
- monto = 0
- horas = número de horas trabajadas (campo extra obligatorio)
- dia_semana = "${diaSemana}" | num_semana = ${numSemana}
- vale_colones = monto del vale si hay, 0 si no
- Cada trabajador = un objeto separado en el array
- Si hay vale, agregá UN objeto extra de tipo GASTO: descripcion="Vale planilla [nombre]",
  monto=[vale], categoria="Mano de obra", pestaña_principal="GASTOS_PROYECTO",
  pestanas_adicionales=["CAJA_GENERAL"]

REGLA CRÍTICA #4 — pago de planilla SIN mención de horas trabajadas:
"pago de planilla a [nombre] por [monto]" sin horas = VALE/ADELANTO (GASTO real con
monto real, categoria "Mano de obra"). NUNCA tipo="PLANILLA" con monto=0 — el gasto
desaparecería en silencio.

PESTAÑAS VÁLIDAS — SOLO ESTOS NOMBRES:
- "CAJA_GENERAL" → gasto operativo/administrativo SSR sin proyecto específico
- "GASTOS_PROYECTO" → gasto imputable a un PROY XXX/YYYY
- "INGRESOS_CLIENTES" → pago de cliente
- "${planillaMes}" → registro de horas trabajadas
- "BASE_PLANILLA" → copia plana de planilla
- "INVENTARIO" → compra para bodega
- "SUBCONTRATOS" → pago a subcontratista

INSTRUCCIONES MÚLTIPLES: siempre devolvés un ARRAY JSON. Un objeto por operación o trabajador.

Formato objeto gasto/ingreso:
{
  "fecha": "${TODAY()}",
  "monto": 45000,
  "moneda": "CRC",
  "tipo": "GASTO",
  "proyecto": "nombre o SS Remodelaciones",
  "proyecto_codigo": "PROY XXX/YYYY o SSR",
  "cliente": null,
  "categoria": "Transporte",
  "descripcion": "3-8 palabras claras",
  "proveedor": null,
  "forma_pago": "Transferencia",
  "responsable": null,
  "es_personal": false,
  "pestaña_principal": "CAJA_GENERAL o GASTOS_PROYECTO según proyecto_codigo",
  "pestanas_adicionales": [],
  "confianza": 95,
  "observaciones": null
}

Formato objeto planilla:
{
  "fecha": "${TODAY()}", "monto": 0, "moneda": "CRC", "horas": 9,
  "dia_semana": "${diaSemana}", "num_semana": ${numSemana}, "vale_colones": 0,
  "tipo": "PLANILLA", "proyecto": "nombre o SS Remodelaciones",
  "proyecto_codigo": "PROY XXX/YYYY o SSR", "categoria": "Mano de obra",
  "descripcion": "Planilla Fernando - 9h ${diaSemana}", "responsable": "Fernando",
  "proveedor": null, "forma_pago": null, "cliente": null, "es_personal": false,
  "pestaña_principal": "${planillaMes}", "pestanas_adicionales": ["BASE_PLANILLA"],
  "confianza": 95, "observaciones": null
}

Respondé ÚNICAMENTE con JSON array válido, sin markdown, sin texto extra.`;
};
// ─── Comando crudo [GASTO:...] / [INGRESO:...] ───────────────
function extraerComandoFinancieroCrudo(texto) {
  if (!texto) return null;

  const m = String(texto).match(
    /\[(GASTO|INGRESO)\s*:\s*([^\]]+)\]/i
  );

  if (!m) return null;

  const tipo = m[1].toUpperCase();

  const partes = m[2]
    .split("|")
    .map(p => p.trim())
    .filter(Boolean);

  const moneda =
    detectarMonedaLocal(
      partes[0] || ""
    );

  const monto =
    parseMontoFinancieroLocal(
      partes[0] || ""
    );

  const descripcion =
    partes[1] ||
    (
      tipo === "GASTO"
        ? "Gasto registrado"
        : "Ingreso registrado"
    );

  const proyectoTexto =
    partes[2] || "";

  const proy =
    detectarProyectoLocal(
      proyectoTexto ||
      `${descripcion} ${texto}`
    );

  return [
    postProcesarMovimiento(
      {
        fecha: TODAY(),

        monto,

        monto_original: monto,

        moneda,

        tipo,

        proyecto:
          proy.nombre ||
          proyectoTexto ||
          "SS Remodelaciones",

        proyecto_codigo:
          proy.codigo ||
          "SSR",

        cliente:
          tipo === "INGRESO"
            ? (
                proy.nombre ||
                proyectoTexto ||
                null
              )
            : null,

        categoria:
          tipo === "GASTO"
            ? categorizarGastoLocal(
                descripcion
              )
            : "Ingreso cliente",

        descripcion,

        proveedor: null,

        forma_pago:
          "Transferencia",

        responsable: null,

        es_personal: false,

        pestaña_principal:
          tipo === "INGRESO"
            ? "INGRESOS_CLIENTES"
            : "GASTOS_PROYECTO",

        pestanas_adicionales:
          ["CAJA_GENERAL"],

        confianza: 90,

        observaciones:
          proyectoTexto
            ? `Proyecto detectado: ${proyectoTexto}`
            : null
      },

      texto
    )
  ];
}


// ─── Parser natural local (mensajes cortos e inequívocos) ────
const MAX_PALABRAS_PARSER_LOCAL = 11;


function extraerMovimientoNaturalLocal(texto) {
  if (!texto) return null;

  const original =
    String(texto).trim();

  const cantidadPalabras =
    original
      .split(/\s+/)
      .filter(Boolean)
      .length;

  if (
    cantidadPalabras >
    MAX_PALABRAS_PARSER_LOCAL
  ) {
    return null;
  }


  const tipo =
    clasificarTipoLocal(
      original
    );


  const esComandoNeutro =
    /\b(apunta|anota|registra|carga)\b/
      .test(
        norm(original)
      );


  if (
    !tipo &&
    !esComandoNeutro
  ) {
    return null;
  }


  // Comando neutro sin tipo claro:
  // dejamos que Claude lo interprete.
  if (!tipo) {
    return null;
  }


  const {
    raw,
    monto
  } =
    // v10.5 — FIX: esta función se llamaba "extraerMontoDeTextoFinanciero"
    // (no existía en el archivo → ReferenceError silencioso cada vez que
    // un mensaje corto pasaba por este parser). El nombre correcto es
    // extraerMontoLocal(), definida más arriba en este mismo archivo.
    extraerMontoLocal(
      original
    );


  if (
    !monto ||
    monto <= 0 ||
    !raw
  ) {
    return null;
  }


  const moneda =
    detectarMonedaLocal(
      original
    );


  let proyectoTexto = "";


  const pm =
    original.match(
      /\b(?:proyecto|obra|cliente)\s+(?:de\s+|del\s+)?([a-záéíóúñ0-9\s/.-]+?)(?:\s+(?:para|por|en|de)\b|$)/i
    );


  if (pm) {
    proyectoTexto =
      pm[1]
        .trim()
        .replace(
          /[,.]+$/g,
          ""
        )
        .replace(
          /^(de|del)\s+/i,
          ""
        );
  }


  const desc =
    construirDescripcionLocal(
      original,
      raw,
      proyectoTexto
    );


  // Descripción pobre:
  // mejor que Claude construya una correcta.
  if (!desc) {
    return null;
  }


  const proy =
    detectarProyectoLocal(
      proyectoTexto ||
      original
    );


  return [
    postProcesarMovimiento(
      {
        fecha: TODAY(),

        monto,

        monto_original: monto,

        moneda,

        tipo,

        proyecto:
          proy.nombre ||
          proyectoTexto ||
          "SS Remodelaciones",

        proyecto_codigo:
          proy.codigo ||
          "SSR",

        cliente:
          tipo === "INGRESO"
            ? (
                proy.nombre ||
                proyectoTexto ||
                null
              )
            : null,

        categoria:
          tipo === "GASTO"
            ? categorizarGastoLocal(
                desc
              )
            : "Ingreso cliente",

        descripcion:
          desc,

        proveedor:
          null,

        forma_pago:
          "Transferencia",

        responsable:
          null,

        es_personal:
          false,

        pestaña_principal:
          tipo === "INGRESO"
            ? "INGRESOS_CLIENTES"
            : "GASTOS_PROYECTO",

        pestanas_adicionales:
          ["CAJA_GENERAL"],

        confianza:
          95,

        observaciones:
          proyectoTexto
            ? `Proyecto detectado: ${proyectoTexto}`
            : null
      },

      original
    )
  ];
}
// ─── Interpretación con Claude + corrección local ────────────
async function interpretarMovimientos(texto) {

  const client =
    new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });


  const response =
    await client.messages.create({

      model:
        process.env.ANTHROPIC_FINANCE_MODEL ||
        "claude-sonnet-4-6",

      max_tokens:
        1500,

      system:
        buildSystemPrompt(),

      messages: [
        {
          role: "user",
          content: texto
        }
      ]

    });


  const raw =
    response.content[0]?.text ||
    "[]";


  const clean =
    raw
      .replace(
        /```json\n?|\n?```/g,
        ""
      )
      .trim();


  const parsed =
    JSON.parse(
      clean
    );


  const movimientos =
    Array.isArray(parsed)
      ? parsed
      : [parsed];


  // Todo lo que devuelve Claude pasa por
  // la corrección determinística:
  //
  // - tipo
  // - cuenta
  // - descripción
  // - moneda
  // - trabajador vs proyecto
  // - SSR operativo vs proyecto real
  return movimientos.map(
    m =>
      postProcesarMovimiento(
        m,
        texto
      )
  );
}


// ─── Registro en Sheets ──────────────────────────────────────
//
// v10.2 — Los errores del webhook ya NO incluyen
// el HTML completo de Google.
//
// Si la respuesta es HTML:
// - implementación borrada
// - redirect de login
// - error 500 de Google
//
// se lanza un mensaje corto y accionable.
//
function esRespuestaHTML(texto) {

  return /<!DOCTYPE|<html|<head|<body/i.test(
    String(
      texto || ""
    )
  );

}


async function registrarEnSheets(data) {

  if (!APPS_SCRIPT_URL) {

    return {
      success: true,
      simulated: true
    };

  }


  const res =
    await fetch(
      APPS_SCRIPT_URL,
      {

        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify(
            data
          )

      }
    );


  const bodyText =
    await res.text();


  if (!res.ok) {

    console.error(
      `❌ Apps Script HTTP ${res.status}. Cuerpo (truncado):`,
      bodyText.slice(
        0,
        400
      )
    );


    if (
      esRespuestaHTML(
        bodyText
      )
    ) {

      throw new Error(

        `Apps Script HTTP ${res.status} — la URL del webhook apunta a una implementación ` +

        `que ya no existe o sin acceso público. Revisá APPS_SCRIPT_URL en Railway ` +

        `(Administrar implementaciones → URL /exec vigente).`

      );

    }


    throw new Error(

      `Apps Script HTTP ${res.status}: ${bodyText.slice(0, 200)}`

    );

  }


  try {

    return JSON.parse(
      bodyText
    );

  } catch (e) {

    console.error(

      "❌ Apps Script respondió no-JSON. Cuerpo (truncado):",

      bodyText.slice(
        0,
        400
      )

    );


    if (
      esRespuestaHTML(
        bodyText
      )
    ) {

      throw new Error(

        `Apps Script devolvió una página HTML en vez de JSON — probablemente la ` +

        `implementación no tiene acceso "Cualquier persona" o la URL es de una ` +

        `versión vieja. Revisá la implementación y APPS_SCRIPT_URL en Railway.`

      );

    }


    throw new Error(

      `Apps Script respondió no-JSON: ${bodyText.slice(0, 200)}`

    );

  }

}


function formatCRC(n) {

  return `₡${Number(n).toLocaleString("es-CR")}`;

}


// ─── Confirmación WhatsApp ───────────────────────────────────
function generarConfirmacionItem(
  data,
  index,
  total
) {

  const tipos = {

    GASTO: {
      emoji: "💸",
      label: "Gasto"
    },

    INGRESO: {
      emoji: "💰",
      label: "Ingreso"
    },

    PLANILLA: {
      emoji: "👷",
      label: "Planilla"
    },

    INVENTARIO: {
      emoji: "📦",
      label: "Inventario"
    }

  };


  const cfg =
    tipos[data.tipo] || {
      emoji: "📋",
      label: data.tipo
    };


  const prefijo =
    total > 1
      ? `*${index + 1}/${total}* `
      : "";


  const lineas = [

    `${prefijo}${cfg.emoji} *${cfg.label} registrado*`,

    `📝 ${data.descripcion}`

  ];


  if (
    data.tipo === "PLANILLA"
  ) {

    if (
      data.horas
    ) {

      lineas.push(
        `🕐 ${data.horas} horas — ${data.dia_semana || ""}`
      );

    }


    if (
      data.vale_colones
    ) {

      lineas.push(
        `💵 Vale: *${formatCRC(data.vale_colones)}*`
      );

    }


    if (
      data.proyecto_codigo &&
      data.proyecto_codigo !== "SSR"
    ) {

      lineas.push(
        `🏗️ ${data.proyecto_codigo}`
      );

    }

  } else {

    if (
      data.moneda === "USD" &&
      data.monto_original
    ) {

      lineas.push(

        `💵 *$${Number(data.monto_original).toLocaleString("en-US")} USD* (≈ ${formatCRC(data.monto)})`

      );

    } else {

      lineas.push(
        `💵 *${formatCRC(data.monto)}*`
      );

    }


    lineas.push(
      `🏦 ${data.cuenta || "BAC CRC"}`
    );


    if (
      data.proyecto_codigo &&
      data.proyecto_codigo !== "SSR"
    ) {

      lineas.push(
        `🏗️ ${data.proyecto_codigo}`
      );

    } else {

      lineas.push(
        `🏢 SSR${data.subtipo_ssr ? ` (${data.subtipo_ssr === "ADMINISTRATIVO" ? "Administrativo" : data.subtipo_ssr === "MANO_DE_OBRA" ? "Mano de obra" : "Operativo"})` : ""}`
      );

    }


    if (
      data.cliente
    ) {

      lineas.push(
        `👤 ${data.cliente}`
      );

    }


    if (
      data.responsable
    ) {

      lineas.push(
        `👷 ${data.responsable}`
      );

    }

  }


  lineas.push(
    `📊 ${data.pestaña_principal}`
  );


  if (
    data.observaciones
  ) {

    lineas.push(
      `📌 ${data.observaciones}`
    );

  }


  return lineas.join(
    "\n"
  );

}
// ─── Pipeline principal ──────────────────────────────────────
async function procesarComandoFinanciero(texto) {

  if (
    !esComandoFinanciero(texto)
  ) {
    return null;
  }


  try {

    // ========================================================
    // 1. INTENTAR PARSERS LOCALES
    //
    // Primero:
    // [GASTO:...] / [INGRESO:...]
    //
    // Segundo:
    // mensaje natural corto e inequívoco
    //
    // Si ninguno puede resolverlo:
    // Claude.
    // ========================================================

    let movimientos =

      extraerComandoFinancieroCrudo(texto) ||

      extraerMovimientoNaturalLocal(texto);


    if (!movimientos) {

      movimientos =
        await interpretarMovimientos(
          texto
        );

    }


    if (
      !movimientos ||
      !movimientos.length
    ) {

      return null;

    }


    // ========================================================
    // 2. PROCESAR MOVIMIENTOS
    // ========================================================

    const confirmaciones = [];
    const errores = [];


    for (
      const datos of movimientos
    ) {

      const esPlanilla =
        datos.tipo === "PLANILLA";


      // PLANILLA puede tener monto = 0 porque
      // registra horas.
      //
      // Los demás movimientos financieros
      // necesitan monto > 0.

      if (
        !esPlanilla &&
        (
          !datos.monto ||
          datos.monto <= 0
        )
      ) {

        errores.push(

          `❌ Monto inválido: ${datos.descripcion || "sin descripción"}`

        );

        continue;

      }


      try {

        // ====================================================
        // 3. REGISTRAR EN APPS SCRIPT
        // ====================================================

        const resultado =
          await registrarEnSheets({

            ...datos,

            audit_id:
              `SSR-${Date.now()}-${Math.floor(Math.random() * 1000)}`,

            canal:
              "whatsapp"

          });


        // ====================================================
        // 4. VALIDAR RESPUESTA DEL ERP
        //
        // FIX v10.1:
        //
        // Antes solo se revisaba DUPLICADO.
        //
        // Si Apps Script rechazaba el movimiento
        // con ERROR_VALIDACION / success:false,
        // Sasha podía responder "registrado"
        // aunque el dato realmente no existiera.
        // ====================================================

        const status =

          resultado?.resultado?.status ||

          resultado?.status;


        const mensajeAS =

          resultado?.resultado?.mensaje ||

          resultado?.error ||

          "";


        if (
          status === "DUPLICADO"
        ) {

          errores.push(

            `⚠️ Duplicado: ${datos.descripcion}`

          );


        } else if (

          resultado?.success === false ||

          resultado?.ok === false ||

          (
            status &&
            status !== "OK"
          )

        ) {

          errores.push(

            `❌ Rechazado por el sistema: ${datos.descripcion}` +

            (
              mensajeAS
                ? ` — ${mensajeAS}`
                : ""
            )

          );


        } else {

          // ==================================================
          // SOLO CONFIRMAMOS AL USUARIO SI EL ERP
          // ACEPTÓ EL MOVIMIENTO
          // ==================================================

          confirmaciones.push(

            generarConfirmacionItem(

              datos,

              confirmaciones.length,

              movimientos.length

            )

          );

        }


      } catch (err) {

        console.error(

          "❌ Error:",

          err.message

        );


        errores.push(

          `❌ Error en: ${datos.descripcion} — ${err.message}`

        );

      }

    }


    // ========================================================
    // 5. RESPUESTA FINAL DE SASHA
    // ========================================================

    const partes = [];


    if (
      confirmaciones.length
    ) {

      partes.push(

        confirmaciones.join(

          "\n\n─────────────\n\n"

        )

      );

    }


    if (
      errores.length
    ) {

      partes.push(

        errores.join(
          "\n"
        )

      );

    }


    partes.push(

      "_Sasha — Agente Financiero SSR_"

    );


    return partes.join(

      "\n\n"

    );


  } catch (err) {

    console.error(

      "❌ finanzas.js error:",

      err.message

    );


    return null;

  }

}
// ============================================================
// LECTURA DE COMPROBANTES BANCARIOS POR IMAGEN (SINPE/BAC)
// ============================================================

async function interpretarComprobante(imageBase64, mimeType, textoAdicional) {

  const client =
    new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });


  const systemPrompt = `Sos el agente financiero IA de SS Remodelaciones. Te llega una
captura de pantalla de una notificación bancaria (BAC, SINPE Móvil u otro banco
costarricense). Extraé los datos del movimiento y devolvé JSON.

CONTEXTO HOY: ${TODAY()}

PROYECTOS (para detectar si el "Detalle" menciona alguno):
${PROYECTOS.map(p => `- ${p.codigo}: ${p.nombre} (alias: ${p.alias.join(", ")})`).join("\n")}

TRABAJADORES (si el detalle menciona a uno, es "Mano de obra", responsable=trabajador,
y su nombre NO sirve para detectar proyecto):
${TRABAJADORES.map(w => `- ${w.nombre} (alias: ${w.alias.join(", ")})`).join("\n")}

CÓMO LEER LA NOTIFICACIÓN:
- "SOLO SENSO SOCIEDAD ANONIMA realizó una transferencia..." → SALIDA de dinero (GASTO).
- "...recibió una transferencia..." o similar → ENTRADA (INGRESO).
- "Monto debitado" en $ (dólares) → la cuenta de origen es "BAC USD".
- "Monto debitado" en ₡ (colones) → la cuenta de origen es "BAC CRC".
- Si ADEMÁS aparece "Monto enviado" en ₡, ESE es el monto real del gasto en colones,
  aunque la cuenta se haya debitado en dólares por conversión. Usá ese monto con
  moneda="CRC" — la cuenta queda "BAC USD" igual.
- Si NO hay "Monto enviado" separado, usá "Monto debitado" tal cual, con su moneda.
- "Detalle" = descripción/motivo. Usalo para "descripcion" y para detectar proyecto.
- Si es GASTO y NO detectás un PROY XXX/YYYY, usá proyecto_codigo="SSR" y pestaña_principal="CAJA_GENERAL".
- Si es GASTO y detectás un PROY XXX/YYYY, usá pestaña_principal="GASTOS_PROYECTO".
- SSR es centro de costo operativo, NO un proyecto.

Devolvé SOLO este JSON (un objeto, no array):
{
  "fecha": "YYYY-MM-DD",
  "tipo": "GASTO o INGRESO",
  "monto": <número, monto real en su moneda>,
  "moneda": "CRC o USD",
  "cuenta": "BAC CRC o BAC USD",
  "proyecto": "nombre o SS Remodelaciones",
  "proyecto_codigo": "PROY XXX/YYYY o SSR",
  "categoria": "categoría breve",
  "descripcion": "el Detalle de la notificación, 3-8 palabras",
  "responsable": "nombre de persona si aplica, si no null",
  "pestaña_principal": "CAJA_GENERAL, GASTOS_PROYECTO o INGRESOS_CLIENTES",
  "pestanas_adicionales": ["CAJA_GENERAL"],
  "confianza": <0-100>,
  "observaciones": "cualquier dato relevante que no encaje arriba"
}

Si la imagen no es una notificación bancaria legible, devolvé:
{"error": "No pude leer un comprobante bancario en esta imagen"}

Respondé ÚNICAMENTE con el JSON, sin markdown, sin texto extra.`;


  const response =
    await client.messages.create({

      model:
        process.env.ANTHROPIC_FINANCE_MODEL ||
        "claude-sonnet-4-6",

      max_tokens:
        1000,

      system:
        systemPrompt,

      messages: [
        {
          role: "user",

          content: [

            {
              type: "image",

              source: {
                type: "base64",
                media_type: mimeType,
                data: imageBase64
              }
            },

            {
              type: "text",

              text:
                textoAdicional ||
                "Leé este comprobante y extraé el movimiento."
            }

          ]
        }
      ]

    });


  const raw =
    response.content[0]?.text ||
    "{}";


  const clean =
    raw
      .replace(
        /```json\n?|\n?```/g,
        ""
      )
      .trim();


  const parsed =
    JSON.parse(
      clean
    );


  if (
    parsed.error
  ) {

    return {
      error: parsed.error
    };

  }


  // IMPORTANTE V10.4:
  //
  // respetarMonedaModelo=true
  //
  // Esto evita que el texto adicional/caption
  // fuerce USD cuando Claude leyó correctamente
  // "Monto enviado" en CRC desde una cuenta BAC USD.
  return postProcesarMovimiento(

    parsed,

    textoAdicional ||
    parsed.descripcion ||
    "",

    {
      respetarMonedaModelo: true
    }

  );

}


async function procesarComprobanteImagen(
  imageBase64,
  mimeType,
  textoAdicional
) {

  try {

    const datos =
      await interpretarComprobante(

        imageBase64,

        mimeType,

        textoAdicional

      );


    if (
      datos.error
    ) {

      return `📭 ${datos.error}. Si querés registrarlo a mano, decime el monto y la descripción.`;

    }


    if (
      !datos.monto ||
      datos.monto <= 0
    ) {

      return `⚠️ No pude leer un monto válido en el comprobante. Registralo a mano si querés.`;

    }


    const resultado =
      await registrarEnSheets({

        ...datos,

        audit_id:
          `SSR-IMG-${Date.now()}`,

        canal:
          "whatsapp_imagen"

      });


    const status =

      resultado?.resultado?.status ||

      resultado?.status;


    if (
      status === "DUPLICADO"
    ) {

      return `⚠️ Este comprobante parece duplicado — ya hay un movimiento similar registrado.`;

    }


    if (

      resultado?.success === false ||

      resultado?.ok === false ||

      (
        status &&
        status !== "OK"
      )

    ) {

      const mensajeAS =

        resultado?.resultado?.mensaje ||

        resultado?.error ||

        "";


      return `❌ El sistema rechazó el comprobante${mensajeAS ? `: ${mensajeAS}` : "."} Registralo a mano si querés.`;

    }


    return (

      generarConfirmacionItem(
        datos,
        0,
        1
      ) +

      "\n\n📸 _Registrado desde comprobante bancario_"

    );


  } catch (err) {

    console.error(

      "❌ procesarComprobanteImagen:",

      err.message

    );


    return `❌ No pude procesar el comprobante: ${err.message}`;

  }

}
// ============================================================
// EXPORTACIONES
// ============================================================

export {
  procesarComandoFinanciero,
  procesarComprobanteImagen,
  interpretarMovimientos,
  interpretarComprobante,
  registrarEnSheets
};
