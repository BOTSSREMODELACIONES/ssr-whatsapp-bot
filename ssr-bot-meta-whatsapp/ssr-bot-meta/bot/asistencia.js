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


  let response;

  try {

    response = await fetch(
      APPS_SCRIPT_URL,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify(payload),

        redirect: "follow",

        // Evita que Sasha quede esperando indefinidamente.
        signal: AbortSignal.timeout(45000)
      }
    );

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
  messageId
}) {

  telefono = normalizarTelefono(telefono);


  const respuesta = await llamarAppsScript({

    accion: "asistencia_entrada",

    telefono: telefono,

    foto: foto || "",

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
        creado: Date.now()
      }
    );


    return {

      manejado: true,

      tipo: "requiere_proyecto",

      trabajador: resultado.trabajador,

      idJornada: resultado.id,

      proyectos: proyectos,

      proyectosDetalle: proyectosDetalle,

      resultado: resultado

    };
  }


  // ----------------------------------------------------------
  // CASO: proyecto único / entrada completa
  // ----------------------------------------------------------

  if (
    resultado &&
    resultado.status === "ok"
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

    pendientesProyecto.delete(telefono);


    return {

      manejado: true,

      tipo: "proyecto_asignado",

      trabajador: resultado.trabajador,

      proyecto:
        resultado.proyecto || proyecto,

      cliente: cliente,

      nombreProyecto: nombreProyecto,

      etiquetaProyecto: etiquetaProyecto,

      idJornada: resultado.id,

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
  messageId
}) {

  telefono = normalizarTelefono(telefono);


  const respuesta = await llamarAppsScript({

    accion: "asistencia_salida",

    telefono: telefono,

    foto: foto || "",

    messageId: messageId || ""

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

    pendientesProyecto.delete(telefono);


    return {

      manejado: true,

      tipo: "salida_registrada",

      trabajador: resultado.trabajador,

      proyecto: resultado.proyecto,

      entrada: resultado.entrada,

      salida: resultado.salida,

      horas: resultado.horas,

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
    `🏗️ ${proyectoMostrar}\n\n` +
    `Tu entrada quedó registrada correctamente.`
  );
}


function mensajeSalidaRegistrada(resultado) {

  return (
    `✅ Salida registrada\n\n` +
    `👷 ${resultado.trabajador || ""}\n` +
    `🏗️ ${resultado.proyecto || ""}\n` +
    `🕐 Entrada: ${resultado.entrada || ""}\n` +
    `🕔 Salida: ${resultado.salida || ""}\n` +
    `⏱️ Horas: ${resultado.horas ?? ""}`
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

    if (
      resultado.status === "no_es_trabajador" ||
      resultado.esTrabajador !== true
    ) {

      return {
        esTrabajador: false,
        error: false,
        estado: resultado
      };
    }

    return {
      esTrabajador: true,
      error: false,
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
  messageId = ""
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
    // ========================================================

    const respuestaEstado =
      await consultarEstado(telefono);


    const estado =
      respuestaEstado &&
      respuestaEstado.resultado
        ? respuestaEstado.resultado
        : respuestaEstado;


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
  // NUEVA LÓGICA:
  //
  // Primera foto:
  //   NO registra asistencia.
  //   Crea un reto fotográfico aleatorio.
  //
  // Segunda foto:
  //   Si existe un reto vigente, se acepta como fotografía
  //   de comprobación y entonces:
  //
  //   - jornada abierta  -> SALIDA
  //   - sin jornada      -> ENTRADA
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
// ------------------------------------------------------

console.log(
  `📸 SASHA ASISTENCIA — validando reto fotográfico de ${telefono}`
);

const retoEsperado =
  retoExistente &&
  retoExistente.reto
    ? retoExistente.reto.id
    : "";


// ------------------------------------------------------
// VALIDAR FOTOGRAFÍA CON CLAUDE
// ------------------------------------------------------

const validacionFoto =
  await validarRetoFotograficoIA(
    imagen,
    retoEsperado
  );


console.log(
  `🔎 SASHA ASISTENCIA — validación IA | ` +
  `esperado=${retoEsperado} | ` +
  `detectado=${validacionFoto?.gestoDetectado || "no_identificable"} | ` +
  `valido=${validacionFoto?.valido === true}`
);


// ------------------------------------------------------
// EL GESTO NO COINCIDE
// NO REGISTRAR ENTRADA NI SALIDA.
// CONSERVAR EL MISMO RETO PARA QUE PUEDA INTENTAR OTRA VEZ.
// ------------------------------------------------------

if (
  !validacionFoto ||
  validacionFoto.valido !== true
) {

  return {
    manejado: true,
    tipo: "reto_fotografico_incorrecto",
    reto: retoExistente.reto,
    validacion: validacionFoto,

    mensaje:
      `❌ La fotografía no cumple con la señal solicitada.\n\n` +
      `🔐 Para validar tu asistencia debes ${retoExistente.reto.texto}.\n\n` +
      `📸 Toma otra fotografía AHORA realizando exactamente esa señal y envíamela.\n\n` +
      `⏱️ El reto original sigue vigente.`
  };
}


// ------------------------------------------------------
// EL GESTO SÍ COINCIDE.
// AHORA SÍ CONSUMIMOS EL RETO.
// ------------------------------------------------------

console.log(
  `✅ SASHA ASISTENCIA — reto fotográfico validado correctamente | ${telefono}`
);

eliminarRetoFotografico(telefono);


    // ======================================================
    // D. SI YA TIENE JORNADA ABIERTA -> REGISTRAR SALIDA
    // ======================================================

    if (estado.jornadaAbierta === true) {

      const salida =
        await registrarSalida({
          telefono: telefono,
          foto: foto,
          messageId: messageId
        });


      if (
        salida &&
        salida.tipo === "salida_registrada"
      ) {

        return {
          ...salida,
          mensaje:
            mensajeSalidaRegistrada(salida)
        };
      }


      return salida;
    }


    // ======================================================
    // E. SI NO TIENE JORNADA ABIERTA -> REGISTRAR ENTRADA
    // ======================================================

    const entrada =
      await registrarEntrada({
        telefono: telefono,
        foto: foto,
        messageId: messageId,
        texto: texto
      });


    // ------------------------------------------------------
    // ENTRADA REGISTRADA DIRECTAMENTE
    // ------------------------------------------------------

    if (
      entrada &&
      entrada.tipo === "entrada_registrada"
    ) {

      return {
        ...entrada,
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

      guardarPendienteProyecto(
        telefono,
        entrada
      );

      return {
        ...entrada,
        mensaje:
          mensajeSeleccionProyecto(entrada)
      };
    }


    // ------------------------------------------------------
    // CUALQUIER OTRO RESULTADO
    // ------------------------------------------------------

    return entrada;
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
