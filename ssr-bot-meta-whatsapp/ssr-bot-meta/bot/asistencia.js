/**
 * ============================================================
 * asistencia.js
 * SASHA SSR — CONTROL DE ASISTENCIA POR WHATSAPP
 * ============================================================
 *
 * RESPONSABILIDAD DE ESTE MÓDULO:
 *
 * 1. Consultar si el número pertenece a un trabajador.
 * 2. Consultar si tiene jornada abierta.
 * 3. Registrar ENTRADA con fotografía.
 * 4. Registrar SALIDA con fotografía.
 * 5. Manejar selección de proyecto cuando hay varios.
 * 6. Comunicarse con SSR ERP mediante APPS_SCRIPT_URL.
 *
 * IMPORTANTE:
 * - NO escribe directamente en Google Sheets.
 * - Toda escritura pasa por Apps Script.
 * - Apps Script sigue siendo la fuente de verdad.
 *
 * ============================================================
 *
 * ── CAMBIOS v2 (12 sept 2026) — DOS FIXES CRÍTICOS REPORTADOS POR
 *    DARWIN CON CAPTURAS REALES DE FERNANDO CHEVEZ ──────────────────
 *
 * BUG 1 — "Sasha trató a un trabajador como cliente nuevo": Fernando
 *   mandó su foto del reto de dedos (frente a una cerca de zinc
 *   oxidada de la obra) y Sasha le respondió describiendo la cerca
 *   como si fuera la foto de un cliente pidiendo cotización —
 *   exactamente el comportamiento de claude.js para fotos de
 *   clientes. Eso solo puede pasar si esTrabajadorSSR() devolvió
 *   esTrabajador:false SIN error — index.js entonces deja caer al
 *   trabajador al flujo comercial normal (ver el fail-closed de
 *   index.js, que solo protege contra el caso error:true).
 *
 *   CAUSA: esTrabajadorSSR() clasificaba como "no es trabajador"
 *   (error:false) cualquier respuesta de Apps Script que NO tuviera
 *   esTrabajador===true, incluida una respuesta ambigua o incompleta
 *   (ej. si el campo esTrabajador viene undefined por un hiccup
 *   puntual del lado de Apps Script, sin ser un error de red). Una
 *   respuesta ambigua se trataba exactamente igual que "esta persona
 *   genuinamente no es trabajador" — con la consecuencia de exponer
 *   a un trabajador real al flujo comercial.
 *
 *   FIX: ahora solo se clasifica como "no es trabajador" cuando Apps
 *   Script lo dice EXPLÍCITAMENTE (status === "no_es_trabajador").
 *   Cualquier otra respuesta que no sea ni eso ni esTrabajador===true
 *   se trata como error (fail closed) — index.js ya sabe manejar ese
 *   caso sin mandar a nadie al flujo comercial.
 *
 * BUG 2 — "hay que repetir el proceso varias veces": cuando el gesto
 *   de los dedos no se reconocía bien, el sistema NUNCA registraba
 *   la entrada/salida — devolvía "reto_fotografico_incorrecto" y le
 *   pedía al trabajador otra foto, indefinidamente, mientras el
 *   reconocimiento de gestos siguiera fallando. El antifraude se
 *   convirtió en un bloqueo real de la asistencia.
 *
 *   FIX: la verificación del gesto ya NO bloquea el registro. Si la
 *   foto no cumple el gesto pedido, se registra la entrada/salida de
 *   todas formas — el resultado incluye `gestoVerificado:false` para
 *   que quede visible en los logs (y disponible para quien construya
 *   la notificación a Darwin) que esa jornada en particular no pasó
 *   la verificación antifraude, sin que eso le impida al trabajador
 *   fichar.
 * ────────────────────────────────────────────────────────────────
 */


// ============================================================
// CONFIGURACIÓN
// ============================================================

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

// ============================================================
// CLAUDE — VALIDACIÓN VISUAL DE RETOS DE ASISTENCIA
// ============================================================

const {
  validarRetoFotograficoIA
} = require("./claude");

// Estado temporal de trabajadores que deben escoger proyecto.
//
// Map:
// telefono -> {
//   idJornada,
//   proyectos,
//   creado
// }

const pendientesProyecto = new Map();


// Tiempo máximo para mantener una selección pendiente.
// 15 minutos.

const PENDIENTE_TTL_MS = 15 * 60 * 1000;

// ============================================================
// VERIFICACIÓN ANTIFRAUDE DE FOTOGRAFÍA DE ASISTENCIA
// ============================================================

// Trabajadores que tienen pendiente un reto fotográfico.
//
// Map:
// telefono -> {
//   tipo: "entrada" | "salida",
//   reto,
//   creado,
//   trabajador
// }

const retosFotograficos = new Map();


// El trabajador dispone de 3 minutos para responder
// con la fotografía solicitada.

const RETO_FOTO_TTL_MS = 3 * 60 * 1000;


// Retos permitidos.
// Por ahora usamos únicamente gestos sencillos.

const RETOS_FOTO = [
  {
    id: "pulgar_arriba",
    texto: "mostrar el pulgar arriba 👍"
  },
  {
    id: "un_dedo",
    texto: "mostrar 1 dedo ☝️"
  },
  {
    id: "dos_dedos",
    texto: "mostrar 2 dedos ✌️"
  },
  {
    id: "tres_dedos",
    texto: "mostrar 3 dedos"
  }
];


function generarRetoFotografico() {

  const indice =
    Math.floor(
      Math.random() * RETOS_FOTO.length
    );

  return RETOS_FOTO[indice];
}


function crearRetoFotografico({
  telefono,
  tipo,
  trabajador
}) {

  telefono = normalizarTelefono(telefono);

  const reto = generarRetoFotografico();

  const dato = {
    tipo: tipo,
    reto: reto,
    creado: Date.now(),
    trabajador: trabajador || ""
  };

  retosFotograficos.set(
    telefono,
    dato
  );

  console.log(
    `🔐 ASISTENCIA — reto creado | ${telefono} | ${tipo} | ${reto.id}`
  );

  return dato;
}


function obtenerRetoFotografico(telefono) {

  telefono = normalizarTelefono(telefono);

  const dato =
    retosFotograficos.get(telefono);

  if (!dato) {
    return null;
  }

  if (
    !dato.creado ||
    Date.now() - dato.creado > RETO_FOTO_TTL_MS
  ) {

    retosFotograficos.delete(telefono);

    console.log(
      `⌛ ASISTENCIA — reto expirado | ${telefono}`
    );

    return null;
  }

  return dato;
}


function eliminarRetoFotografico(telefono) {

  telefono = normalizarTelefono(telefono);

  retosFotograficos.delete(telefono);
}


function mensajeRetoFotografico(
  trabajador,
  reto,
  tipo
) {

  const movimiento =
    tipo === "salida"
      ? "salida"
      : "entrada";

  return (
    `👷 ${trabajador || "Trabajador"}\n\n` +
    `🔐 Verificación de ${movimiento}\n\n` +
    `📸 Toma AHORA una nueva fotografía ` +
    `${reto.texto}.\n\n` +
    `⏱️ Tienes 3 minutos para enviarla.\n\n` +
    `⚠️ La fotografía debe ser tomada en este momento.`
  );
}

// ============================================================
// UTILIDADES
// ============================================================

function normalizarTelefono(valor) {

  if (!valor) return "";

  return String(valor)
    .replace(/\D/g, "")
    .trim();
}


function normalizarTexto(valor) {

  return String(valor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}


function limpiarPendientesExpirados() {

  const ahora = Date.now();

  for (const [telefono, dato] of pendientesProyecto.entries()) {

    if (
      !dato ||
      !dato.creado ||
      ahora - dato.creado > PENDIENTE_TTL_MS
    ) {

      pendientesProyecto.delete(telefono);

    }
  }
}


// ============================================================
// COMUNICACIÓN CON APPS SCRIPT
// ============================================================

async function llamarAppsScript(payload) {

  if (!APPS_SCRIPT_URL) {
    console.error("❌ ASISTENCIA: falta APPS_SCRIPT_URL");

    throw new Error(
      "Falta la variable de entorno APPS_SCRIPT_URL"
    );
  }


  console.log(
    "📡 ASISTENCIA → Apps Script:",
    JSON.stringify(payload)
  );


  // ══════════════════════════════════════════════════════════════
  // v6 (16 sept 2026) — FIX CRÍTICO: SEGUIR REDIRECCIONES A MANO,
  // PRESERVANDO EL MÉTODO POST Y EL CUERPO ORIGINAL.
  //
  // BUG REAL: una entrada de Darwin se registró con el gesto
  // correcto, pero la respuesta que Apps Script le devolvió al bot
  // fue {"status":"ok","mensaje":"Sasha Financiero SSR V13
  // activo",...} — el mensaje de RESPALDO que doGet() devuelve
  // cuando no reconoce ninguna acción. El bot manda esto por POST,
  // nunca por GET — así que no debería poder caer ahí jamás.
  //
  // CAUSA RAÍZ: las Web Apps de Apps Script casi siempre responden
  // con una redirección 302 hacia una URL de
  // script.googleusercontent.com. El fetch() de Node, por
  // especificación (WHATWG Fetch Standard), CONVIERTE
  // AUTOMÁTICAMENTE un POST en GET al seguir una redirección 301,
  // 302 o 303 — y descarta el cuerpo (body) en el proceso. La
  // segunda petición (ya GET, sin accion ni ningún dato) le llega a
  // Apps Script vacía, y cae directo en el mensaje genérico de
  // doGet(). Como no todas las llamadas generan esa redirección de
  // la misma forma, el bug es intermitente — coincide exactamente
  // con lo que reportaste.
  //
  // FIX: en vez de dejar que fetch() siga la redirección solo
  // (redirect: "follow"), la seguimos NOSOTROS a mano
  // (redirect: "manual"), reenviando la misma petición POST con el
  // mismo cuerpo a la URL indicada en el header Location. Esto
  // preserva el método y los datos en cada salto, así que Apps
  // Script siempre recibe el POST real, sin importar cuántas
  // redirecciones haga Google por el camino.
  // ══════════════════════════════════════════════════════════════

  const MAX_REDIRECTS = 5;

  // v8 (16 sept 2026) — FIX del fix de ayer: el primer salto (a
  // /exec, donde Apps Script REALMENTE ejecuta el código) debe ir
  // por POST — eso ya estaba bien. Pero la redirección que Apps
  // Script devuelve apunta a una URL de
  // script.googleusercontent.com/macros/echo — un servidor de
  // CONTENIDO que solo sirve el resultado que Apps Script ya
  // calculó en la primera petición. Esa URL únicamente acepta GET
  // (confirmado: forzar POST ahí devolvía HTTP 405 Method Not
  // Allowed). El fix de ayer forzaba POST también en ese segundo
  // salto por error. Ahora: POST solo en el primer salto; cualquier
  // redirección posterior se sigue con GET (sin cuerpo), que es lo
  // que ese servidor de contenido espera.
  async function hacerPost(url, intento, metodo) {

    if (intento > MAX_REDIRECTS) {
      throw new Error(
        `Demasiadas redirecciones (${MAX_REDIRECTS}) al llamar Apps Script.`
      );
    }

    const esPrimerSalto = metodo === "POST";

    const opciones = {
      method: metodo,

      redirect: "manual",

      // Evita que Sasha quede esperando indefinidamente.
      signal: AbortSignal.timeout(45000)
    };

    if (esPrimerSalto) {
      opciones.headers = { "Content-Type": "application/json" };
      opciones.body = JSON.stringify(payload);
    }

    const resp = await fetch(url, opciones);

    // status 0 / type "opaqueredirect" es lo que devuelve fetch en
    // algunos entornos con redirect:"manual" cuando no expone el
    // Location directamente; para el fetch nativo de Node (undici)
    // sí exponemos el header Location normalmente en 301/302/303/307/308.
    if (
      resp.status >= 300 &&
      resp.status < 400 &&
      resp.headers.get("location")
    ) {

      const destino = new URL(
        resp.headers.get("location"),
        url
      ).toString();

      console.log(
        `↪️ ASISTENCIA — Apps Script redirigió (HTTP ${resp.status}), siguiendo con GET a: ${destino}`
      );

      return hacerPost(destino, intento + 1, "GET");
    }

    return resp;
  }


  let response;

  try {

    response = await hacerPost(APPS_SCRIPT_URL, 1, "POST");

  } catch (err) {

    console.error(
      "❌ ASISTENCIA: error llamando Apps Script:",
      err.name,
      err.message
    );

    throw new Error(
      "No se pudo comunicar con Apps Script: " +
      err.message
    );
  }


  console.log(
    "📥 ASISTENCIA ← Apps Script HTTP:",
    response.status
  );


  let texto;

  try {

    texto = await response.text();

  } catch (err) {

    console.error(
      "❌ ASISTENCIA: no se pudo leer respuesta:",
      err.message
    );

    throw new Error(
      "No se pudo leer la respuesta de Apps Script."
    );
  }


  console.log(
    "📄 ASISTENCIA ← respuesta:",
    String(texto || "").substring(0, 1000)
  );


  let data;

  try {

    data = JSON.parse(texto);

  } catch (err) {

    console.error(
      "❌ ASISTENCIA: Apps Script devolvió respuesta no JSON:",
      String(texto || "").substring(0, 500)
    );

    throw new Error(
      "Apps Script no devolvió JSON válido. Respuesta: " +
      String(texto || "").substring(0, 500)
    );
  }


  if (!response.ok) {

    console.error(
      "❌ ASISTENCIA: HTTP no exitoso:",
      response.status,
      String(texto || "").substring(0, 500)
    );

    throw new Error(
      `Apps Script HTTP ${response.status}: ` +
      String(texto || "").substring(0, 500)
    );
  }


  console.log(
    "✅ ASISTENCIA: respuesta Apps Script procesada correctamente"
  );


  return data;
}

// ============================================================
// CONSULTAR ESTADO DEL TRABAJADOR
// ============================================================

async function consultarEstado(telefono) {

  telefono = normalizarTelefono(telefono);


  return await llamarAppsScript({

    accion: "asistencia_estado",

    telefono: telefono

  });
}


// ============================================================
// REGISTRAR ENTRADA
// ============================================================

async function registrarEntrada({
  telefono,
  foto,
  messageId,
  gestoVerificado = true
}) {

  telefono = normalizarTelefono(telefono);


  const respuesta = await llamarAppsScript({

    accion: "asistencia_entrada",

    telefono: telefono,

    // v7 (16 sept 2026) — FIX: SASHA_WEBHOOK_ASISTENCIA_ENTRADA_ en
    // Apps Script lee data.fotoId, no data.foto. Con el nombre
    // equivocado, Apps Script nunca recibía el ID de la fotografía —
    // las columnas FOTO_ENTRADA/FOTO_SALIDA quedaban siempre vacías
    // en ASISTENCIA_SASHA, aunque el resto del registro funcionara
    // bien. Se corrige el nombre del campo; no hace falta tocar nada
    // en Apps Script, que ya esperaba "fotoId" desde el principio.
    fotoId: foto || "",

    messageId: messageId || ""

  });


  const resultado =
    respuesta &&
    respuesta.resultado
      ? respuesta.resultado
      : respuesta;


  // ----------------------------------------------------------
  // CASO: trabajador tiene varios proyectos
  // ----------------------------------------------------------

  if (
    resultado &&
    (
      resultado.status === "requiere_proyecto" ||
      resultado.requiereProyecto === true
    )
  ) {

    // Códigos reales de proyecto.
    // Estos son los que se utilizan para registrar en el ERP.
    const proyectos =
      Array.isArray(resultado.proyectosDisponibles)
        ? resultado.proyectosDisponibles
        : [];


    // Detalle visual recibido desde Apps Script.
    // Ejemplo:
    // {
    //   codigo: "PROY 065/2026",
    //   cliente: "José Flores",
    //   etiqueta: "PROY 065/2026 — José Flores"
    // }
    const proyectosDetalle =
      Array.isArray(resultado.proyectosDetalle)
        ? resultado.proyectosDetalle
        : [];


    // Guardamos AMBAS listas.
    //
    // proyectos:
    // se utiliza internamente para detectar qué código seleccionó.
    //
    // proyectosDetalle:
    // se utiliza únicamente para mostrar una descripción amigable.
    pendientesProyecto.set(
      telefono,
      {
        idJornada: resultado.id,
        proyectos: proyectos,
        proyectosDetalle: proyectosDetalle,
        creado: Date.now(),
        gestoVerificado: gestoVerificado
      }
    );


    return {

      manejado: true,

      tipo: "requiere_proyecto",

      trabajador: resultado.trabajador,

      idJornada: resultado.id,

      proyectos: proyectos,

      proyectosDetalle: proyectosDetalle,

      gestoVerificado: gestoVerificado,

      resultado: resultado

    };
  }


  // ----------------------------------------------------------
  // CASO: proyecto único / entrada completa
  //
  // v5 (16 sept 2026) — FIX: se agrega "&& resultado.trabajador" a
  // la condición de éxito.
  //
  // BUG REAL: Apps Script devolvió, para una llamada real de
  // asistencia_entrada, esto: {"status":"ok","mensaje":"Sasha
  // Financiero SSR V13 activo","motor":"..."} — una respuesta
  // genérica sin trabajador/hora/proyecto, como si hubiera
  // respondido el handler equivocado. Como antes solo se exigía
  // status==="ok", esto se tomaba como un registro EXITOSO y se le
  // confirmaba al trabajador "✅ Entrada registrada" con todos los
  // campos vacíos — una confirmación falsa, mucho peor que un error
  // honesto, porque no hay forma de saber si el ERP realmente
  // guardó algo.
  //
  // FIX: una respuesta "ok" real de asistencia_entrada SIEMPRE trae
  // el nombre del trabajador (es el primer dato que llena Apps
  // Script). Si falta, ya no se trata como éxito — cae al bloque de
  // error de abajo con un mensaje honesto pidiendo reintentar, en
  // vez de una confirmación inventada.
  // ----------------------------------------------------------

  if (
    resultado &&
    resultado.status === "ok" &&
    resultado.trabajador
  ) {

    pendientesProyecto.delete(telefono);

    // Conservamos también la información descriptiva del proyecto
    // que venga desde Apps Script.
    const etiquetaProyecto =
      resultado.etiquetaProyecto ||
      resultado.proyectoEtiqueta ||
      (
        resultado.cliente && resultado.proyecto
          ? `${resultado.proyecto} — ${resultado.cliente}`
          : resultado.proyecto || ""
      );

    return {

      manejado: true,

      tipo: "entrada_registrada",

      trabajador: resultado.trabajador,

      hora: resultado.hora,

      proyecto: resultado.proyecto,

      cliente: resultado.cliente || "",

      nombreProyecto: resultado.nombreProyecto || "",

      etiquetaProyecto: etiquetaProyecto,

      asignacionAutomatica:
        resultado.asignacionAutomatica === true,

      gestoVerificado: gestoVerificado,

      resultado: resultado

    };
  }


  // v5 — caso nuevo: Apps Script respondió "ok" pero sin los datos
  // esperados (respuesta ajena/incompleta). Se distingue del error
  // genérico de abajo para poder dar un mensaje más claro.
  if (
    resultado &&
    resultado.status === "ok" &&
    !resultado.trabajador
  ) {

    console.error(
      `❌ ASISTENCIA — asistencia_entrada respondió "ok" sin datos de trabajador (respuesta ajena/incompleta) para ${telefono}:`,
      JSON.stringify(resultado)
    );

    return {

      manejado: true,

      tipo: "error",

      error: "respuesta_incompleta",

      resultado: resultado

    };
  }


  return {

    manejado: true,

    tipo: "error",

    resultado: resultado

  };
}


// ============================================================
// ASIGNAR PROYECTO
// ============================================================

async function asignarProyecto({
  telefono,
  proyecto,
  idJornada
}) {

  telefono = normalizarTelefono(telefono);

  proyecto = String(proyecto || "").trim();


  const pendiente =
    pendientesProyecto.get(telefono);


  const idFinal =
    idJornada ||
    (pendiente && pendiente.idJornada) ||
    "";


  if (!idFinal) {

    return {

      manejado: true,

      tipo: "error",

      error: "No existe jornada pendiente para asignar proyecto."

    };
  }


  const respuesta = await llamarAppsScript({

    accion: "asistencia_asignar_proyecto",

    idJornada: idFinal,

    proyecto: proyecto,

    telefono: telefono

  });


  const resultado =
    respuesta &&
    respuesta.resultado
      ? respuesta.resultado
      : respuesta;


  if (
    resultado &&
    resultado.status === "ok"
  ) {

    // IMPORTANTE:
    // Capturamos el pendiente ANTES de eliminarlo,
    // porque ahí tenemos proyectosDetalle con código + cliente.
    const pendienteActual =
      pendientesProyecto.get(telefono);

    const proyectosDetalle =
      pendienteActual &&
      Array.isArray(pendienteActual.proyectosDetalle)
        ? pendienteActual.proyectosDetalle
        : [];

    const detalleSeleccionado =
      proyectosDetalle.find(
        item =>
          item &&
          String(item.codigo || "").trim() ===
          String(resultado.proyecto || proyecto || "").trim()
      ) || null;

    const cliente =
      resultado.cliente ||
      (detalleSeleccionado
        ? detalleSeleccionado.cliente
        : "") ||
      "";

    const nombreProyecto =
      resultado.nombreProyecto ||
      (detalleSeleccionado
        ? detalleSeleccionado.nombreProyecto
        : "") ||
      "";

    const etiquetaProyecto =
      resultado.etiquetaProyecto ||
      resultado.proyectoEtiqueta ||
      (
        detalleSeleccionado &&
        detalleSeleccionado.etiqueta
          ? detalleSeleccionado.etiqueta
          : (
              cliente && (resultado.proyecto || proyecto)
                ? `${resultado.proyecto || proyecto} — ${cliente}`
                : resultado.proyecto || proyecto || ""
            )
      );

    const gestoVerificado =
      pendienteActual && typeof pendienteActual.gestoVerificado === "boolean"
        ? pendienteActual.gestoVerificado
        : true;

    pendientesProyecto.delete(telefono);


    return {

      manejado: true,

      tipo: "proyecto_asignado",

      trabajador: resultado.trabajador,
      hora:
  resultado.hora ||
  resultado.entrada ||
  "",

      proyecto:
        resultado.proyecto || proyecto,

      cliente: cliente,

      nombreProyecto: nombreProyecto,

      etiquetaProyecto: etiquetaProyecto,

      idJornada: resultado.id,

      gestoVerificado: gestoVerificado,

      resultado: resultado

    };
  }


  return {

    manejado: true,

    tipo: "error",

    resultado: resultado

  };
}


// ============================================================
// REGISTRAR SALIDA
// ============================================================

async function registrarSalida({
  telefono,
  foto,
  messageId,
  gestoVerificado = true
}) {

  telefono = normalizarTelefono(telefono);


  const respuesta = await llamarAppsScript({

    accion: "asistencia_salida",

    telefono: telefono,

    // v7 — ver nota extensa en registrarEntrada(): Apps Script lee
    // data.fotoId, no data.foto.
    fotoId: foto || "",

    messageId: messageId || ""

  });


  const resultado =
    respuesta &&
    respuesta.resultado
      ? respuesta.resultado
      : respuesta;


  // v5 — mismo blindaje que registrarEntrada(): una respuesta "ok"
  // real de asistencia_salida siempre trae el nombre del trabajador.
  if (
    resultado &&
    resultado.status === "ok" &&
    resultado.trabajador
  ) {

    pendientesProyecto.delete(telefono);


return {

  manejado: true,

  tipo: "salida_registrada",

  trabajador: resultado.trabajador,

  proyecto: resultado.proyecto,

  entrada: resultado.entrada,

  salida: resultado.salida,

  // Compatibilidad
  horas: resultado.horas,

  // NUEVOS DATOS DEL RESUMEN
  horasHoy: resultado.horasHoy,

  horasHoyTexto:
    resultado.horasHoyTexto,

  horasSemana:
    resultado.horasSemana,

  horasSemanaTexto:
    resultado.horasSemanaTexto,

  tarifaHora:
    resultado.tarifaHora,

  pagoSemana:
    resultado.pagoSemana,

  pagoSemanaTexto:
    resultado.pagoSemanaTexto,

  gestoVerificado: gestoVerificado,

  resultado: resultado

};
    
  }


  // v5 — "ok" sin datos de trabajador: respuesta ajena/incompleta,
  // no se confirma como éxito (ver nota extensa en registrarEntrada).
  if (
    resultado &&
    resultado.status === "ok" &&
    !resultado.trabajador
  ) {

    console.error(
      `❌ ASISTENCIA — asistencia_salida respondió "ok" sin datos de trabajador (respuesta ajena/incompleta) para ${telefono}:`,
      JSON.stringify(resultado)
    );

    return {

      manejado: true,

      tipo: "error",

      error: "respuesta_incompleta",

      resultado: resultado

    };
  }


  return {

    manejado: true,

    tipo: "error",

    resultado: resultado

  };
}


// ============================================================
// OBTENER PROYECTO DESDE RESPUESTA DEL TRABAJADOR
// ============================================================

function detectarProyectoPendiente(
  telefono,
  texto
) {

  limpiarPendientesExpirados();


  telefono = normalizarTelefono(telefono);


  const pendiente =
    pendientesProyecto.get(telefono);


  if (!pendiente) {

    return null;

  }


  const proyectos =
    pendiente.proyectos || [];


  if (!proyectos.length) {

    return null;

  }


  const textoOriginal =
    String(texto || "").trim();


  const textoNormalizado =
    normalizarTexto(textoOriginal);


  // ----------------------------------------------------------
  // OPCIÓN NUMÉRICA
  //
  // Sasha:
  // 1. PROY 074/2026
  // 2. PROY 065/2026
  //
  // Trabajador:
  // "2"
  // ----------------------------------------------------------

  const numero =
    parseInt(textoNormalizado, 10);


  if (
    !isNaN(numero) &&
    numero >= 1 &&
    numero <= proyectos.length
  ) {

    return {

      proyecto: proyectos[numero - 1],

      idJornada: pendiente.idJornada

    };
  }


  // ----------------------------------------------------------
  // RESPUESTA CON EL CÓDIGO DEL PROYECTO
  // ----------------------------------------------------------

  for (const proyecto of proyectos) {

    if (
      normalizarTexto(proyecto) ===
      textoNormalizado
    ) {

      return {

        proyecto: proyecto,

        idJornada: pendiente.idJornada

      };
    }
  }


  // ----------------------------------------------------------
  // BÚSQUEDA PARCIAL
  // ----------------------------------------------------------

  for (const proyecto of proyectos) {

    const p =
      normalizarTexto(proyecto);


    if (
      textoNormalizado.includes(p) ||
      p.includes(textoNormalizado)
    ) {

      return {

        proyecto: proyecto,

        idJornada: pendiente.idJornada

      };
    }
  }


  return {

    proyecto: null,

    idJornada: pendiente.idJornada,

    proyectos: proyectos

  };
}


// ============================================================
// CONSTRUIR MENSAJE PARA SELECCIÓN DE PROYECTO
// ============================================================

function mensajeSeleccionProyecto(
  trabajador,
  proyectos,
  proyectosDetalle = []
) {

  // ----------------------------------------------------------
  // CONSTRUIR LISTA PARA WHATSAPP
  // ----------------------------------------------------------
  //
  // "proyectos" conserva los códigos reales utilizados
  // internamente para registrar la asistencia.
  //
  // "proyectosDetalle" contiene la información visual:
  // código + cliente.
  // ----------------------------------------------------------

  const lista =
    proyectos
      .map(
        (proyecto, index) => {

          const detalle =
            Array.isArray(proyectosDetalle)
              ? proyectosDetalle.find(
                  item =>
                    item &&
                    String(item.codigo || "").trim() ===
                    String(proyecto || "").trim()
                )
              : null;


          const etiqueta =
            detalle && detalle.etiqueta
              ? detalle.etiqueta
              : proyecto;


          return `${index + 1}. ${etiqueta}`;
        }
      )
      .join("\n");


  return (
    `👷 ${trabajador || "Trabajador"}, recibí tu entrada.\n\n` +
    `¿A cuál proyecto debemos cargar las horas de hoy?\n\n` +
    `${lista}\n\n` +
    `Respóndeme solamente con el número de la opción.`
  );
}

// ============================================================
// MENSAJES DE CONFIRMACIÓN
// ============================================================

function mensajeEntradaRegistrada(resultado) {

  let mensaje =
    `✅ Entrada registrada\n\n` +
    `👷 ${resultado.trabajador || ""}\n` +
    `🕐 Hora: ${resultado.hora || ""}`;


  if (resultado.proyecto) {

    mensaje +=
      `\n🏗️ Proyecto: ${resultado.proyecto}`;

  }


  return mensaje;
}


function mensajeProyectoAsignado(resultado) {

  const proyectoMostrar =
    resultado.etiquetaProyecto ||
    resultado.proyectoEtiqueta ||
    (
      resultado.cliente && resultado.proyecto
        ? `${resultado.proyecto} — ${resultado.cliente}`
        : resultado.proyecto || ""
    );

  return (
    `✅ Proyecto asignado\n\n` +
    `👷 ${resultado.trabajador || ""}\n` +
    `🕐 Hora: ${resultado.hora || ""}\n` +
    `🏗️ ${proyectoMostrar}\n\n` +
    `Tu entrada quedó registrada correctamente.`
  );
}


function mensajeSalidaRegistrada(resultado) {

  const horasHoy =
    resultado.horasHoyTexto ||
    resultado.resultado?.horasHoyTexto ||
    "";

  const horasSemana =
    resultado.horasSemanaTexto ||
    resultado.resultado?.horasSemanaTexto ||
    "";

  const pagoSemana =
    resultado.pagoSemanaTexto ||
    resultado.resultado?.pagoSemanaTexto ||
    "";

  return (
    `📤 ASISTENCIA — SALIDA\n\n` +

    `👷 ${resultado.trabajador || ""}\n` +
    `🏗️ ${resultado.proyecto || ""}\n\n` +

    `🕐 Entrada: ${resultado.entrada || ""}\n` +
    `🕔 Salida: ${resultado.salida || ""}\n\n` +

    `⏱️ Horas laboradas hoy: ${horasHoy}\n` +
    `📊 Horas acumuladas en la semana: ${horasSemana}\n` +
    `💰 Pago acumulado de la semana: ${pagoSemana}\n\n` +

    `🧾 Monto acumulado antes de vales.\n` +
    `📸 Fotografía registrada`
  );
}


// ============================================================
// SABER SI HAY PROYECTO PENDIENTE
// ============================================================

function tieneProyectoPendiente(
  telefono
) {

  limpiarPendientesExpirados();

  telefono =
    normalizarTelefono(telefono);


  return pendientesProyecto.has(
    telefono
  );
}


// ============================================================
// OBTENER DATOS DEL PROYECTO PENDIENTE
// ============================================================

function obtenerProyectoPendiente(
  telefono
) {

  limpiarPendientesExpirados();

  telefono =
    normalizarTelefono(telefono);


  return (
    pendientesProyecto.get(telefono) ||
    null
  );
}


// ============================================================
// PROCESAR RESPUESTA DE PROYECTO
// ============================================================

async function procesarRespuestaProyecto({
  telefono,
  texto
}) {

  telefono =
    normalizarTelefono(telefono);


  const deteccion =
    detectarProyectoPendiente(
      telefono,
      texto
    );


  if (!deteccion) {

    return {

      manejado: false

    };
  }


  if (!deteccion.proyecto) {

    return {

      manejado: true,

      tipo: "proyecto_invalido",

      proyectos:
        deteccion.proyectos || []

    };
  }


  return await asignarProyecto({

    telefono: telefono,

    proyecto:
      deteccion.proyecto,

    idJornada:
      deteccion.idJornada

  });
}

// ============================================================
// INTEGRACIÓN PRINCIPAL CON INDEX.JS
// ============================================================

/**
 * Determina si el número que escribe por WhatsApp
 * pertenece a un trabajador registrado en SSR.
 *
 * Devuelve:
 * true  -> es trabajador
 * false -> no es trabajador
 *
 * v2 — FIX BUG 1: antes, cualquier respuesta de Apps Script que NO
 * tuviera esTrabajador===true se clasificaba como "no es trabajador"
 * (error:false) — incluida una respuesta ambigua/incompleta que no
 * fuera ni un "no_es_trabajador" explícito ni un error de red. Eso
 * dejaba caer a un trabajador real al flujo comercial por un hiccup
 * puntual de Apps Script. Ahora solo se clasifica como "no es
 * trabajador" cuando el status dice EXACTAMENTE "no_es_trabajador".
 * Cualquier otra respuesta ambigua se trata como error (fail closed),
 * que index.js ya sabe manejar sin exponer a nadie al flujo comercial.
 */

async function esTrabajadorSSR(telefono) {

  telefono = normalizarTelefono(telefono);

  if (!telefono) {
    return {
      esTrabajador: false,
      error: false
    };
  }

  try {

    const respuesta = await consultarEstado(telefono);

    const resultado =
      respuesta &&
      respuesta.resultado
        ? respuesta.resultado
        : respuesta;

    if (!resultado) {

      return {
        esTrabajador: false,
        error: true,
        motivo: "estado_invalido"
      };
    }

    // Caso explícito e inequívoco: Apps Script confirma que este
    // número NO pertenece a ningún trabajador registrado.
    if (resultado.status === "no_es_trabajador") {

      return {
        esTrabajador: false,
        error: false,
        estado: resultado
      };
    }

    // Caso explícito e inequívoco: SÍ es trabajador.
    if (resultado.esTrabajador === true) {

      return {
        esTrabajador: true,
        error: false,
        estado: resultado
      };
    }

    // v2 — Ni lo uno ni lo otro: respuesta ambigua/incompleta de
    // Apps Script (ej. campo esTrabajador ausente por un hiccup
    // puntual). NO asumimos que es cliente — se trata como error
    // para que index.js falle cerrado, igual que con cualquier otro
    // error de comunicación.
    console.warn(
      "⚠️ ASISTENCIA: respuesta ambigua de asistencia_estado (ni no_es_trabajador ni esTrabajador:true) — se trata como error para no exponer al flujo comercial:",
      JSON.stringify(resultado)
    );

    return {
      esTrabajador: false,
      error: true,
      motivo: "respuesta_ambigua",
      estado: resultado
    };

  } catch (err) {

    console.error(
      "❌ Error verificando trabajador SSR:",
      err.message
    );

    // IMPORTANTE:
    // Un error de Apps Script NO significa
    // que la persona sea un cliente.
    return {
      esTrabajador: false,
      error: true,
      motivo: err.message
    };
  }
}

// ============================================================
// PROCESADOR PRINCIPAL DE ASISTENCIA
// ============================================================

/**
 * Procesador de alto nivel utilizado por index.js.
 *
 * Recibe:
 * {
 *   telefono,
 *   texto,
 *   foto,
 *   messageId
 * }
 *
 * Apps Script sigue siendo la fuente de verdad.
 */
async function procesarAsistencia({
  telefono,
  texto = "",
  foto = "",
  imagen = null,
  messageId = "",
  // v4 (16 sept 2026) — evitar la doble consulta de estado.
  // index.js ya llama a esTrabajadorSSR() (que internamente hace un
  // consultarEstado()) ANTES de llegar acá. Si ese resultado viene
  // fresco y confirma esTrabajador:true, se reutiliza en vez de
  // volver a preguntarle lo mismo a Apps Script un instante después.
  estadoPrevio = null
}) {

  try {

    telefono = normalizarTelefono(telefono);

    const textoOriginal =
      String(texto || "").trim();

    const textoNormalizado =
      normalizarTexto(textoOriginal);


    if (!telefono) {

      return {
        manejado: false,
        tipo: "error",
        error: "telefono_requerido"
      };
    }


    // ========================================================
    // 1. SI ESTÁ ESPERANDO SELECCIÓN DE PROYECTO
    // ========================================================

    if (tieneProyectoPendiente(telefono)) {

      const resultadoProyecto =
        await procesarRespuestaProyecto({
          telefono: telefono,
          texto: textoOriginal
        });


      if (
        resultadoProyecto &&
        resultadoProyecto.tipo === "proyecto_asignado"
      ) {

        return {
          ...resultadoProyecto,
          mensaje:
            mensajeProyectoAsignado(
              resultadoProyecto
            )
        };
      }


      if (
        resultadoProyecto &&
        resultadoProyecto.tipo === "proyecto_invalido"
      ) {

        const pendiente =
          obtenerProyectoPendiente(telefono);

        return {
          manejado: true,
          tipo: "proyecto_invalido",
          proyectos:
            resultadoProyecto.proyectos || [],
          mensaje:
            mensajeSeleccionProyecto(
              "Trabajador",
              pendiente
                ? pendiente.proyectos
                : resultadoProyecto.proyectos || []
            )
        };
      }


      return resultadoProyecto;
    }


    // ========================================================
    // 2. CONSULTAR ESTADO ACTUAL EN APPS SCRIPT
    //
    // v4 — FIX: index.js ya consultó esto milisegundos antes, vía
    // esTrabajadorSSR(). Repetir la misma pregunta acá duplicaba
    // TODAS las llamadas a Apps Script (una foto = 2 consultas de
    // estado idénticas en vez de 1), lo que multiplica el tráfico
    // hacia Apps Script sin necesidad. Se reutiliza el resultado ya
    // fetcheado cuando viene disponible y confirma esTrabajador:true;
    // si no viene (o viene incompleto), se hace la consulta propia
    // como respaldo, igual que antes.
    // ========================================================

    let estado;

    if (
      estadoPrevio &&
      estadoPrevio.esTrabajador === true
    ) {

      estado = estadoPrevio;

    } else {

      const respuestaEstado =
        await consultarEstado(telefono);


      estado =
        respuestaEstado &&
        respuestaEstado.resultado
          ? respuestaEstado.resultado
          : respuestaEstado;

    }


    if (!estado) {

      return {
        manejado: true,
        tipo: "error",
        error: "estado_invalido"
      };
    }



    // ========================================================
    // 3. SI NO ES TRABAJADOR
    // ========================================================

    if (
      estado.status === "no_es_trabajador" ||
      estado.esTrabajador !== true
    ) {

      return {
        manejado: false,
        tipo: "no_es_trabajador"
      };
    }


    // ========================================================
    // 4. DETERMINAR SI EL MENSAJE INDICA ENTRADA O SALIDA
    // ========================================================

    const pideEntrada =
      textoNormalizado === "entrada" ||
      textoNormalizado.includes("registrar entrada") ||
      textoNormalizado.includes("marcar entrada") ||
      textoNormalizado.includes("mi entrada") ||
      textoNormalizado.includes("entrando") ||
      textoNormalizado.includes("llegue") ||
      textoNormalizado.includes("llegué");


    const pideSalida =
      textoNormalizado === "salida" ||
      textoNormalizado.includes("registrar salida") ||
      textoNormalizado.includes("marcar salida") ||
      textoNormalizado.includes("mi salida") ||
      textoNormalizado.includes("saliendo") ||
      textoNormalizado.includes("me voy") ||
      textoNormalizado.includes("termine") ||
      textoNormalizado.includes("terminé");

  // ========================================================
  // 5 Y 6. FOTO -> VALIDACIÓN FOTOGRÁFICA
  // ========================================================
  //
  // v2 — LA VERIFICACIÓN DEL GESTO YA NO BLOQUEA EL REGISTRO.
  //
  // Primera foto:
  //   NO registra asistencia todavía.
  //   Crea un reto fotográfico aleatorio (sigue teniendo valor
  //   como señal antifraude para revisión posterior).
  //
  // Segunda foto:
  //   Se valida el gesto contra el reto. Si coincide, perfecto.
  //   Si NO coincide, YA NO se le pide reintentar — se registra
  //   la entrada/salida de todas formas, marcada con
  //   gestoVerificado:false para que quede visible en los logs
  //   (y disponible para una futura notificación a Darwin) sin
  //   bloquear al trabajador.
  //
  // El reto expira automáticamente según FOTO_RETO_TTL_MS.
  // ========================================================

  if (foto) {

    // ------------------------------------------------------
    // A. BUSCAR SI YA EXISTE UN RETO FOTOGRÁFICO VIGENTE
    // ------------------------------------------------------

    const retoExistente =
      obtenerRetoFotografico(telefono);


    // ------------------------------------------------------
    // B. NO EXISTE RETO:
    //    ESTA ES LA PRIMERA FOTO.
    //    NO REGISTRAMOS ASISTENCIA TODAVÍA.
    // ------------------------------------------------------

    if (!retoExistente) {

  const tipoMovimiento =
    estado.jornadaAbierta === true
      ? "salida"
      : "entrada";

  const nuevoReto =
    crearRetoFotografico({
      telefono: telefono,
      tipo: tipoMovimiento,
      trabajador: estado.trabajador
    });

  console.log(
    `📸 SASHA ASISTENCIA — reto fotográfico creado para ${telefono}:`,
    nuevoReto
  );

  return {
    manejado: true,
    tipo: "reto_fotografico",
    reto: nuevoReto.reto,
    mensaje:
      mensajeRetoFotografico(
        estado.trabajador,
        nuevoReto.reto,
        tipoMovimiento
      )
  };
}

  // ------------------------------------------------------
// C. YA EXISTE RETO:
//    VALIDAR CON IA QUE LA FOTO CUMPLE EL GESTO.
//    v2 — el resultado de esta validación YA NO decide si se
//    registra o no; solo se guarda como bandera informativa.
// ------------------------------------------------------

console.log(
  `📸 SASHA ASISTENCIA — validando reto fotográfico de ${telefono}`
);

const retoEsperado =
  retoExistente &&
  retoExistente.reto
    ? retoExistente.reto.id
    : "";


// El reto ya cumplió su función para este intento — se libera de
// inmediato (no hace falta esperar a nada más) para no dejar al
// trabajador "atascado" en un reto viejo en su próximo movimiento.
eliminarRetoFotografico(telefono);


// ══════════════════════════════════════════════════════════════
// v3 (16 sept 2026) — PARALELIZAR VALIDACIÓN DE GESTO + REGISTRO
//
// Como el resultado de la validación del gesto YA NO decide si se
// registra la asistencia (v2), no hay ninguna razón para esperar a
// que Claude termine de analizar la foto ANTES de escribir en Apps
// Script. Antes las dos llamadas corrían EN SERIE (primero Claude,
// después Apps Script), sumando sus tiempos — eso es lo que hacía
// que la confirmación tardara más de lo normal. Ahora corren EN
// PARALELO: el trabajador espera lo que tarde la más lenta de las
// dos, no la suma de ambas.
// ══════════════════════════════════════════════════════════════

const validacionPromise =
  validarRetoFotograficoIA(imagen, retoEsperado)
    .catch(errValidacion => {

      // v2 — si la propia validación falla (ej. imagen ilegible,
      // timeout de Claude), tampoco bloqueamos: se trata igual que
      // un gesto no coincidente, y la asistencia se registra igual.
      console.warn(
        `⚠️ SASHA ASISTENCIA — la validación del gesto falló técnicamente, se registra igual | ${telefono}:`,
        errValidacion.message
      );

      return null;
    });

const esSalida = estado.jornadaAbierta === true;

const registroPromise =
  esSalida
    ? registrarSalida({ telefono, foto, messageId })
    : registrarEntrada({ telefono, foto, messageId, texto });

const [validacionFoto, registro] =
  await Promise.all([
    validacionPromise,
    registroPromise
  ]);


console.log(
  `🔎 SASHA ASISTENCIA — validación IA | ` +
  `esperado=${retoEsperado} | ` +
  `detectado=${validacionFoto?.gestoDetectado || "no_identificable"} | ` +
  `valido=${validacionFoto?.valido === true}`
);


const gestoVerificado =
  !!(validacionFoto && validacionFoto.valido === true);

if (!gestoVerificado) {

  // v2 — FIX BUG 2: antes acá se retornaba
  // "reto_fotografico_incorrecto" y se le pedía al trabajador
  // reintentar indefinidamente mientras el gesto no coincidiera.
  // Ahora solo se deja constancia en el log — el registro de
  // entrada/salida ya corrió en paralelo más arriba, sin esperar
  // este resultado.
  console.warn(
    `⚠️ SASHA ASISTENCIA — gesto NO coincide, se registró de todas formas (ya no se bloquea) | ${telefono} | esperado=${retoEsperado} detectado=${validacionFoto?.gestoDetectado || "no_identificable"}`
  );

} else {

  console.log(
    `✅ SASHA ASISTENCIA — reto fotográfico validado correctamente | ${telefono}`
  );
}


    // ======================================================
    // D. SI YA TENÍA JORNADA ABIERTA -> ERA UNA SALIDA
    // ======================================================

    if (esSalida) {

      if (
        registro &&
        registro.tipo === "salida_registrada"
      ) {

        return {
          ...registro,
          gestoVerificado,
          mensaje:
            mensajeSalidaRegistrada(registro)
        };
      }


      // v5 — FIX: antes esta rama devolvía el objeto de error SIN
      // mensaje. index.js solo envía texto al trabajador si
      // resultadoAsistencia.mensaje viene con algo — si no, se queda
      // en silencio total (registra un warning en el log nomás, y
      // el trabajador nunca se entera de nada). Con el nuevo chequeo
      // de "ok sin trabajador" (ver registrarSalida), este caso
      // ahora se puede dar más seguido, así que es importante que
      // siempre lleve un mensaje real.
      return {
        ...registro,
        gestoVerificado,
        mensaje:
          "⚠️ Tu salida quedó pendiente de confirmar — el sistema no pudo darme el resultado completo en este momento. Probá de nuevo en unos segundos; si ya marcaste salida, no hace falta repetirlo dos veces."
      };
    }


    // ======================================================
    // E. SI NO TENÍA JORNADA ABIERTA -> ERA UNA ENTRADA
    // ======================================================

    const entrada = registro;


    // ------------------------------------------------------
    // ENTRADA REGISTRADA DIRECTAMENTE
    // ------------------------------------------------------

    if (
      entrada &&
      entrada.tipo === "entrada_registrada"
    ) {

      return {
        ...entrada,
        gestoVerificado,
        mensaje:
          mensajeEntradaRegistrada(entrada)
      };
    }


    // ------------------------------------------------------
    // ENTRADA REGISTRADA PERO REQUIERE SELECCIONAR PROYECTO
    // ------------------------------------------------------

    if (
      entrada &&
      entrada.tipo === "requiere_proyecto"
    ) {

      // v3 — FIX: acá se llamaba a guardarPendienteProyecto(), una
      // función que NUNCA existió en este archivo — cualquier
      // trabajador con más de un proyecto activo que llegara a este
      // punto hacía crashear procesarAsistencia() con un
      // ReferenceError real (justo el tipo de excepción que produce
      // el "⚠️ No pude procesar la asistencia en este momento."
      // genérico). No hacía falta de todos modos: registrarEntrada()
      // ya guarda el pendiente internamente (pendientesProyecto.set)
      // antes de devolver este resultado. Se elimina la llamada rota.

      return {
        ...entrada,
        gestoVerificado,
        mensaje:
          mensajeSeleccionProyecto(entrada)
      };
    }


    // ------------------------------------------------------
    // CUALQUIER OTRO RESULTADO
    // ------------------------------------------------------
    // v5 — mismo fix que en la rama de salida: siempre con mensaje,
    // nunca en silencio.

    return {
      ...entrada,
      gestoVerificado,
      mensaje:
        "⚠️ Tu entrada quedó pendiente de confirmar — el sistema no pudo darme el resultado completo en este momento. Probá de nuevo en unos segundos; si ya marcaste entrada, no hace falta repetirlo dos veces."
    };
  }   

    // ========================================================
    // 7. SOLICITUD EXPLÍCITA DE ENTRADA
    // ========================================================

    if (pideEntrada) {

      if (estado.jornadaAbierta === true) {

        return {
          manejado: true,
          tipo: "jornada_ya_abierta",
          trabajador: estado.trabajador,
          jornada: estado.jornada,
          mensaje:
            "⚠️ Ya tienes una jornada abierta.\n\n" +
            "Para registrar la salida, envíame la fotografía de salida."
        };
      }


      return {
        manejado: true,
        tipo: "solicitar_foto_entrada",
        trabajador: estado.trabajador,
        mensaje:
          `👷 ${estado.trabajador || "Trabajador"}\n\n` +
          "📸 Envíame una fotografía desde el proyecto para registrar tu entrada."
      };
    }


    // ========================================================
    // 8. SOLICITUD EXPLÍCITA DE SALIDA
    // ========================================================

    if (pideSalida) {

      if (estado.jornadaAbierta !== true) {

        return {
          manejado: true,
          tipo: "sin_jornada_abierta",
          trabajador: estado.trabajador,
          mensaje:
            "⚠️ No tienes una jornada abierta actualmente."
        };
      }


      return {
        manejado: true,
        tipo: "solicitar_foto_salida",
        trabajador: estado.trabajador,
        jornada: estado.jornada,
        mensaje:
          `👷 ${estado.trabajador || "Trabajador"}\n\n` +
          "📸 Envíame una fotografía para registrar tu salida."
      };
    }


    // ========================================================
    // 9. MENSAJE NORMAL DE UN TRABAJADOR
    // ========================================================

    if (estado.jornadaAbierta === true) {

      return {
        manejado: true,
        tipo: "trabajador_con_jornada",
        trabajador: estado.trabajador,
        jornada: estado.jornada,
        mensaje:
          `👷 Hola ${estado.trabajador || ""}.\n\n` +
          "Tienes una jornada abierta actualmente.\n\n" +
          "📸 Cuando termines, envíame la fotografía de salida."
      };
    }


    return {
      manejado: true,
      tipo: "trabajador_sin_jornada",
      trabajador: estado.trabajador,
      mensaje:
        `👷 Hola ${estado.trabajador || ""}.\n\n` +
        "📸 Envíame una fotografía desde el proyecto para registrar tu entrada."
    };


  } catch (err) {

    console.error(
      "❌ Error procesando SASHA ASISTENCIA:",
      err
    );


    return {
      manejado: true,
      tipo: "error",
      error: err.message,
      mensaje:
        "⚠️ No pude procesar la asistencia en este momento."
    };
  }
}


// ============================================================
// EXPORTACIONES
// ============================================================

module.exports = {

  // ----------------------------------------------------------
  // FUNCIONES PRINCIPALES UTILIZADAS POR INDEX.JS
  // ----------------------------------------------------------

  esTrabajadorSSR,

  procesarAsistencia,


  // ----------------------------------------------------------
  // FUNCIONES DEL MÓDULO DE ASISTENCIA
  // ----------------------------------------------------------

  consultarEstado,

  registrarEntrada,

  registrarSalida,

  asignarProyecto,

  procesarRespuestaProyecto,

  detectarProyectoPendiente,

  tieneProyectoPendiente,

  obtenerProyectoPendiente,

  mensajeSeleccionProyecto,

  mensajeEntradaRegistrada,

  mensajeProyectoAsignado,

  mensajeSalidaRegistrada,

  normalizarTelefono

};
