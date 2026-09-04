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
        signal: AbortSignal.timeout(15000)
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


    return {

      manejado: true,

      tipo: "entrada_registrada",

      trabajador: resultado.trabajador,

      hora: resultado.hora,

      proyecto: resultado.proyecto,

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

    pendientesProyecto.delete(telefono);


    return {

      manejado: true,

      tipo: "proyecto_asignado",

      trabajador: resultado.trabajador,

      proyecto: resultado.proyecto,

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

mensaje:
  mensajeSeleccionProyecto(
    entrada.trabajador,
    entrada.proyectos || [],
    entrada.proyectosDetalle || []
  )

  // ----------------------------------------------------------
  // CONSTRUIR LISTA PARA WHATSAPP
  // ----------------------------------------------------------
  //
  // El código real sigue estando en "proyectos".
  //
  // "proyectosDetalle" solamente mejora lo que ve
  // el trabajador.
  //
  // Ejemplo:
  //
  // 1. PROY 074/2026 — Stephanie Jimenez
  // 2. PROY 065/2026 — José Flores
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

  return (
    `✅ Proyecto asignado\n\n` +
    `👷 ${resultado.trabajador || ""}\n` +
    `🏗️ ${resultado.proyecto || ""}\n\n` +
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

  try {

    telefono = normalizarTelefono(telefono);

    if (!telefono) {
      return false;
    }

    const respuesta = await consultarEstado(telefono);

    const resultado =
      respuesta &&
      respuesta.resultado
        ? respuesta.resultado
        : respuesta;

    if (!resultado) {
      return false;
    }

    if (resultado.status === "no_es_trabajador") {
      return false;
    }

    if (resultado.esTrabajador === true) {
      return true;
    }

    return false;

  } catch (err) {

    console.error(
      "❌ Error verificando trabajador SSR:",
      err.message
    );

    return false;
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
    // 5. SI MANDA FOTO Y YA TIENE JORNADA ABIERTA -> SALIDA
    // ========================================================

    if (
      foto &&
      estado.jornadaAbierta === true
    ) {

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


    // ========================================================
    // 6. SI MANDA FOTO Y NO TIENE JORNADA -> ENTRADA
    // ========================================================

    if (
      foto &&
      estado.jornadaAbierta !== true
    ) {

      const entrada =
        await registrarEntrada({
          telefono: telefono,
          foto: foto,
          messageId: messageId
        });


      if (
        entrada &&
        entrada.tipo === "requiere_proyecto"
      ) {

        return {
          ...entrada,
          mensaje:
            mensajeSeleccionProyecto(
              entrada.trabajador,
              entrada.proyectos || []
            )
        };
      }


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
