/**
 * ============================================================
 * confirmaciones.js — Confirmación de asistencia a visitas técnicas
 * SS Remodelaciones — Sasha Bot
 * ============================================================
 *
 * OBJETIVO (pedido por Darwin, 16 sept 2026):
 * La noche anterior a cada visita agendada (7:00 p.m.), mandarle al
 * cliente un recordatorio con dos botones — "Sí, confirmo" / "No
 * puedo" — preguntándole si confirma su visita técnica de mañana.
 * Avisar tanto a Darwin como a Melvin por WhatsApp cuando se manda
 * la pregunta (resumen de a quiénes se les preguntó) y otra vez
 * cuando el cliente responde (confirmó / no puede).
 *
 * DISEÑO:
 * - El cron (registrado en server.js a las 7:00 p.m. CR) llama a
 *   enviarConfirmacionesVisitasManana(), que usa
 *   calendar.js:listVisitsForDate("mañana") para traer todas las
 *   visitas de mañana con nombre/teléfono/hora ya parseados desde
 *   la descripción del evento.
 * - Cada botón lleva como ID "visita_confirma_si|<eventId>" o
 *   "visita_confirma_no|<eventId>". WhatsApp devuelve ese ID tal
 *   cual cuando el cliente toca el botón (ver server.js, tipo
 *   "interactive" → button_reply.id), y llega a index.js como si
 *   fuera el texto del mensaje del cliente.
 * - index.js llama a manejarRespuestaConfirmacion(from, texto) ANTES
 *   de cualquier otro procesamiento; si el texto matchea el patrón,
 *   esta función se encarga de todo y devuelve true (index.js no
 *   sigue procesando ese mensaje de ninguna otra forma). Si no
 *   matchea, devuelve false y index.js continúa normal.
 *
 * ROBUSTEZ ANTE REDEPLOYS:
 * visitasPendientesHoy es una caché EN MEMORIA (se pierde si el
 * proceso se reinicia — algo que pasa seguido en este proyecto,
 * varias veces por sesión de trabajo). Como la pregunta se manda a
 * las 7pm y la respuesta del cliente puede llegar horas después,
 * NO se puede depender solo de esta caché. Por eso
 * manejarRespuestaConfirmacion() SIEMPRE tiene un respaldo: si el
 * eventId no está en la caché, reconstruye los datos de la visita
 * consultando Calendar directamente (calendar.js:getEventById), que
 * no depende de que el proceso siga siendo el mismo.
 * ============================================================
 */

const { sendButtons, sendText } = require("./messenger");
const { listVisitsForDate, getEventById } = require("./calendar");

// Darwin y Melvin — los dos números que reciben aviso de cada
// confirmación/rechazo de visita.
const SUPERVISORES_CONFIRMACION = ["+50683091817", "+50671981370"];

// eventId -> { name, phone, hourStr, dateStr, project, zone }
// Solo un respaldo de "mejor esfuerzo" para responder más rápido y
// con más detalle sin tener que volver a consultar Calendar — ver
// nota de robustez arriba. Nunca es la única fuente de verdad.
const visitasPendientesHoy = new Map();

function idBoton(accion, eventId) {
  return `visita_confirma_${accion}|${eventId}`;
}

// Parser inverso del ID del botón. Devuelve { accion, eventId } o
// null si el texto no matchea el patrón esperado.
function parsearIdBoton(texto) {
  const m = String(texto || "").match(/^visita_confirma_(si|no)\|(.+)$/);
  if (!m) return null;
  return { accion: m[1], eventId: m[2] };
}

/**
 * Llamada por el cron de las 7:00 p.m. (registrado en server.js).
 * Busca todas las visitas agendadas para mañana y le manda a cada
 * cliente un mensaje con botones Sí/No preguntando si confirma.
 * Al final, avisa a Darwin y Melvin con el resumen de a quiénes se
 * les preguntó.
 */
async function enviarConfirmacionesVisitasManana() {
  console.log("🕖 Cron confirmación de visitas → buscando visitas de mañana...");

  let visitas = [];
  try {
    visitas = await listVisitsForDate("mañana");
  } catch (err) {
    console.error("❌ Error consultando visitas de mañana:", err.message);
    return;
  }

  if (!visitas.length) {
    console.log("📭 No hay visitas agendadas para mañana — no se envía nada.");
    return;
  }

  // Nueva noche, nueva caché — lo de ayer ya no aplica.
  visitasPendientesHoy.clear();

  const enviadas = [];
  const fallidas  = [];

  for (const visita of visitas) {
    if (!visita.phone) {
      console.warn(`⚠️ Visita de "${visita.name}" sin teléfono identificable en la descripción — no se le puede mandar confirmación.`);
      fallidas.push({ ...visita, motivo: "sin_telefono" });
      continue;
    }

    visitasPendientesHoy.set(visita.eventId, visita);

    const mensaje =
      `Hola ${visita.name || ""} 👋 Le escribimos de *SS Remodelaciones*.\n\n` +
      `Le recordamos su visita técnica programada para *mañana a las ${visita.hourStr || "9:00 a.m."}*.\n\n` +
      `¿Desea confirmar su visita técnica para mañana?`;

    try {
      await sendButtons(
        visita.phone,
        mensaje,
        [
          { id: idBoton("si", visita.eventId), title: "Sí, confirmo" },
          { id: idBoton("no", visita.eventId), title: "No puedo" },
        ]
      );
      enviadas.push(visita);
      console.log(`✅ Confirmación enviada a ${visita.name} (${visita.phone})`);
    } catch (err) {
      console.error(`❌ No se pudo enviar confirmación a ${visita.phone}:`, err.message);
      fallidas.push({ ...visita, motivo: "error_envio" });
    }
  }

  if (enviadas.length || fallidas.length) {
    const lineas = [
      `📋 *Confirmaciones de visita — mañana*`,
      ``,
    ];

    if (enviadas.length) {
      lineas.push(`✅ Se le preguntó a ${enviadas.length} cliente(s):`);
      enviadas.forEach(v => {
        lineas.push(`• ${v.name || "Cliente"} — ${v.hourStr || "9:00 a.m."}${v.zone ? ` (${v.zone})` : ""}`);
      });
    }

    if (fallidas.length) {
      lineas.push(``, `⚠️ No se le pudo preguntar a ${fallidas.length}:`);
      fallidas.forEach(v => {
        const razon = v.motivo === "sin_telefono" ? "sin teléfono en la cita" : "error al enviar";
        lineas.push(`• ${v.name || "Cliente"} — ${v.hourStr || "9:00 a.m."} (${razon})`);
      });
    }

    lineas.push(``, `Les aviso apenas respondan.`);

    const resumen = lineas.join("\n");

    for (const sup of SUPERVISORES_CONFIRMACION) {
      sendText(sup, resumen).catch(e => console.warn(`⚠️ No se pudo avisar a ${sup}:`, e.message));
    }
  }
}

/**
 * Llamada desde index.js con CADA mensaje entrante, antes de
 * cualquier otro procesamiento. Si `texto` es el ID de uno de los
 * botones de confirmación, maneja la respuesta completa (mensaje al
 * cliente + aviso a Darwin/Melvin) y devuelve true. Si no matchea el
 * patrón esperado, devuelve false de inmediato sin hacer nada más,
 * para que index.js siga su flujo normal.
 */
async function manejarRespuestaConfirmacion(from, texto) {
  const parsed = parsearIdBoton(texto);
  if (!parsed) return false;

  const { accion, eventId } = parsed;

  // 1) Intentar la caché en memoria primero (más rápido, y ya trae
  //    nombre/hora/zona sin volver a golpear la API de Calendar).
  let visita = visitasPendientesHoy.get(eventId) || null;

  // 2) Respaldo: si no está en caché (proceso reiniciado entre las
  //    7pm y ahora, o cliente respondiendo mucho después), reconstruir
  //    desde Calendar directamente por el eventId.
  if (!visita) {
    const evento = await getEventById(eventId);
    if (evento) {
      // Reutilizamos el mismo parseo de descripción que usa
      // listVisitsForDate() en calendar.js, para no duplicar el
      // regex acá — como getEventById() devuelve el evento crudo de
      // la API, replicamos la extracción mínima necesaria.
      const desc = String(evento.description || "");
      const campo = (regex) => {
        const m = desc.match(regex);
        return m ? m[1].trim() : "";
      };
      visita = {
        eventId,
        name:  campo(/👤 Cliente:\s*(.+)/) || (evento.summary || "").replace(/^🏗️ Visita SSR — /, "").split("|")[0].trim(),
        phone: campo(/📱 WhatsApp:\s*(.+)/),
        zone:  campo(/📍 Zona:\s*(.+)/),
        hourStr: evento.start && evento.start.dateTime
          ? new Date(evento.start.dateTime).toLocaleString("es-CR", {
              timeZone: "America/Costa_Rica", hour: "numeric", minute: "2-digit", hour12: true,
            })
          : "9:00 a.m.",
      };
    }
  }

  const nombreCliente = visita?.name || "El cliente";
  const horaVisita     = visita?.hourStr || "9:00 a.m.";
  const zonaVisita     = visita?.zone || "";

  if (accion === "si") {

    await sendText(from, `¡Perfecto! Su visita queda confirmada para mañana a las ${horaVisita}. ¡Hasta entonces! 😊`);

    const aviso =
      `✅ *Cliente confirmó su visita de mañana*\n\n` +
      `👤 ${nombreCliente}\n` +
      `🕐 ${horaVisita}\n` +
      (zonaVisita ? `📍 ${zonaVisita}\n` : "") +
      `📱 ${from}`;

    for (const sup of SUPERVISORES_CONFIRMACION) {
      sendText(sup, aviso).catch(() => {});
    }

  } else {

    await sendText(from, `Entendido, gracias por avisar. Alguien de nuestro equipo le va a escribir para reprogramar. 🙏`);

    const aviso =
      `⚠️ *Cliente NO puede recibir la visita de mañana*\n\n` +
      `👤 ${nombreCliente}\n` +
      `🕐 ${horaVisita}\n` +
      (zonaVisita ? `📍 ${zonaVisita}\n` : "") +
      `📱 ${from}\n\n` +
      `Hay que contactarlo para reprogramar.`;

    for (const sup of SUPERVISORES_CONFIRMACION) {
      sendText(sup, aviso).catch(() => {});
    }
  }

  visitasPendientesHoy.delete(eventId);

  return true;
}

module.exports = {
  enviarConfirmacionesVisitasManana,
  manejarRespuestaConfirmacion,
};
