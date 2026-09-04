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

    throw new Error(
      "Falta la variable de entorno APPS_SCRIPT_URL"
    );
  }


  const response = await fetch(
    APPS_SCRIPT_URL,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify(payload),

      redirect: "follow"
    }
  );


  const texto = await response.text();


  let data;

  try {

    data = JSON.parse(texto);

  } catch (err) {

    throw new Error(
      "Apps Script no devolvió JSON válido. Respuesta: " +
      texto.substring(0, 500)
    );
  }


  if (!response.ok) {

    throw new Error(
      `Apps Script HTTP ${response.status}: ${texto.substring(0, 500)}`
    );
  }


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

    const proyectos =
      Array.isArray(resultado.proyectosDisponibles)
        ? resultado.proyectosDisponibles
        : [];


    pendientesProyecto.set(
      telefono,
      {
        idJornada: resultado.id,
        proyectos: proyectos,
        creado: Date.now()
      }
    );


    return {

      manejado: true,

      tipo: "requiere_proyecto",

      trabajador: resultado.trabajador,

      idJornada: resultado.id,

      proyectos: proyectos,

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

function mensajeSeleccionProyecto(
  trabajador,
  proyectos
) {

  const lista =
    proyectos
      .map(
        (proyecto, index) =>
          `${index + 1}. ${proyecto}`
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
// EXPORTACIONES
// ============================================================

module.exports = {

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
