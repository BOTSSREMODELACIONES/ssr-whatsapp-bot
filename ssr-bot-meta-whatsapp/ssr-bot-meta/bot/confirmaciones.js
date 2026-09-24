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
 * Avisar a Darwin y Melvin cuando se manda la pregunta y otra vez
 * cuando el cliente responde.
 *
 * ── CAMBIOS v2 (23 sept 2026) — PLANTILLA APROBADA ─────────────
 * BUG: el mensaje se mandaba como botones interactivos (sendButtons),
 *   que WhatsApp solo entrega si el cliente escribió en las últimas
 *   24 h. Casi todos los clientes agendan días antes, así que la
 *   confirmación NO les llegaba (Meta respondía "OK" y después fallaba
 *   con error 131047, invisible hasta server.js v21).
 * FIX: si WA_PLANTILLA_CONFIRMACION_VISITA está configurada, se envía
 *   la plantilla aprobada "confirmacion_visita" con:
 *     {{1}} nombre del cliente
 *     {{2}} fecha de la visita  (ej. "lunes 28 de septiembre")
 *     {{3}} hora de la visita   (tomada del evento real de Calendar,
 *                                así sirve para cualquier horario)
 *   y los dos botones de respuesta rápida llevan como payload el mismo
 *   ID de siempre ("visita_confirma_si|<eventId>"), así que
 *   manejarRespuestaConfirmacion() funciona igual. server.js v21 ya
 *   convierte la respuesta a un botón de plantilla (msg.type "button")
 *   en texto para index.js.
 *   Si la variable NO está configurada, se usa el envío anterior
 *   (solo llega a clientes con la ventana de 24 h abierta) y el
 *   resumen a Darwin/Melvin lo advierte.
 * Además, cada envío y cada respuesta quedan registrados en MENSAJES,
 *   así se ven en el chat del CRM/ERP.
 *
 * DISEÑO:
 * - El cron (server.js, 7:00 p.m. CR) llama a
 *   enviarConfirmacionesVisitasManana(), que usa
 *   calendar.js:listVisitsForDate("mañana").
 * - index.js llama a manejarRespuestaConfirmacion(from, texto) ANTES
 *   de cualquier otro procesamiento.
 *
 * ROBUSTEZ ANTE REDEPLOYS:
 * visitasPendientesHoy es solo una caché en memoria. Si el eventId no
 * está en caché, se reconstruye la visita desde Calendar
 * (calendar.js:getEventById).
 * ============================================================
 */

const { sendButtons, sendText } = require("./messenger");
const { listVisitsForDate, getEventById } = require("./calendar");
const { plantillaConfigurada, enviarPlantilla } = require("./plantillas");
const memoria = require("./memoria");

const VAR_PLANTILLA = "WA_PLANTILLA_CONFIRMACION_VISITA";
const TZ = "America/Costa_Rica";

// Darwin y Melvin — reciben aviso de cada confirmación/rechazo.
const SUPERVISORES_CONFIRMACION = ["+50683091817", "+50671981370"];

// eventId -> { name, phone, hourStr, dateStr, project, zone }
const visitasPendientesHoy = new Map();

function idBoton(accion, eventId) {
  return `visita_confirma_${accion}|${eventId}`;
}

function parsearIdBoton(texto) {
  const m = String(texto || "").match(/^visita_confirma_(si|no)\|(.+)$/);
  if (!m) return null;
  return { accion: m[1], eventId: m[2] };
}

// "lunes 28 de septiembre" para mañana, en hora de Costa Rica.
function etiquetaManana() {
  const manana = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return manana.toLocaleDateString("es-CR", {
    timeZone: TZ, weekday: "long", day: "numeric", month: "long",
  });
}

function registrarEnMemoria(phone, name, content) {
  memoria.guardarMensaje({
    phone, clientName: name || null, direction: "out", type: "text", content, session: null,
  }).catch(e => console.warn("⚠️ No se pudo registrar la confirmación en memoria:", e.message));
}

/**
 * Llamada por el cron de las 7:00 p.m.
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

  visitasPendientesHoy.clear();

  const usarPlantilla = !!plantillaConfigurada(VAR_PLANTILLA);
  const fechaTexto = etiquetaManana();

  const enviadas = [];
  const fallidas = [];

  for (const visita of visitas) {
    if (!visita.phone) {
      console.warn(`⚠️ Visita de "${visita.name}" sin teléfono identificable en la descripción — no se le puede mandar confirmación.`);
      fallidas.push({ ...visita, motivo: "sin_telefono" });
      continue;
    }

    visitasPendientesHoy.set(visita.eventId, visita);

    const hora = visita.hourStr || "9:00 a.m.";

    try {
      if (usarPlantilla) {
        await enviarPlantilla(visita.phone, VAR_PLANTILLA, {
          cuerpo: [visita.name || "estimado cliente", fechaTexto, hora],
          botonesPayload: [idBoton("si", visita.eventId), idBoton("no", visita.eventId)],
        });
      } else {
        const mensaje =
          `Hola ${visita.name || ""} 👋 Le escribimos de *SS Remodelaciones*.\n\n` +
          `Le recordamos su visita técnica programada para *mañana a las ${hora}*.\n\n` +
          `¿Desea confirmar su visita técnica para mañana?`;

        await sendButtons(
          visita.phone,
          mensaje,
          [
            { id: idBoton("si", visita.eventId), title: "Sí, confirmo" },
            { id: idBoton("no", visita.eventId), title: "No puedo" },
          ]
        );
      }

      registrarEnMemoria(
        visita.phone, visita.name,
        `[Confirmación de visita enviada${usarPlantilla ? " (plantilla)" : ""}] ¿Confirma su visita técnica de mañana ${fechaTexto} a las ${hora}? — Botones: Sí, confirmo / No puedo`
      );

      enviadas.push(visita);
      console.log(`✅ Confirmación enviada a ${visita.name} (${visita.phone})${usarPlantilla ? " vía plantilla" : ""}`);
    } catch (err) {
      console.error(`❌ No se pudo enviar confirmación a ${visita.phone}:`, err.message);
      fallidas.push({ ...visita, motivo: "error_envio", detalle: err.message });
    }
  }

  if (enviadas.length || fallidas.length) {
    const lineas = [
      `📋 *Confirmaciones de visita — mañana ${fechaTexto}*`,
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
        const razon = v.motivo === "sin_telefono"
          ? "sin teléfono en la cita"
          : `error al enviar${v.detalle ? `: ${v.detalle.slice(0, 120)}` : ""}`;
        lineas.push(`• ${v.name || "Cliente"} — ${v.hourStr || "9:00 a.m."} (${razon})`);
      });
    }

    if (!usarPlantilla) {
      lineas.push(
        ``,
        `⚠️ Sin plantilla configurada (${VAR_PLANTILLA}): el mensaje solo le llega a quien escribió en las últimas 24 h.`
      );
    }

    lineas.push(``, `Les aviso apenas respondan.`);

    const resumen = lineas.join("\n");

    for (const sup of SUPERVISORES_CONFIRMACION) {
      sendText(sup, resumen).catch(e => console.warn(`⚠️ No se pudo avisar a ${sup}:`, e.message));
    }
  }
}

/**
 * Llamada desde index.js con CADA mensaje entrante. Si `texto` es el
 * ID/payload de uno de los botones de confirmación, maneja la respuesta
 * completa y devuelve true. Si no, devuelve false.
 */
async function manejarRespuestaConfirmacion(from, texto) {
  const parsed = parsearIdBoton(texto);
  if (!parsed) return false;

  const { accion, eventId } = parsed;

  let visita = visitasPendientesHoy.get(eventId) || null;

  if (!visita) {
    const evento = await getEventById(eventId);
    if (evento) {
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
              timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true,
            })
          : "9:00 a.m.",
      };
    }
  }

  const nombreCliente = visita?.name || "El cliente";
  const horaVisita    = visita?.hourStr || "9:00 a.m.";
  const zonaVisita    = visita?.zone || "";
  const fromE164      = String(from).startsWith("+") ? String(from) : `+${from}`;

  memoria.guardarMensaje({
    phone: fromE164, clientName: visita?.name || null, direction: "in", type: "text",
    content: accion === "si" ? "[Botón] Sí, confirmo" : "[Botón] No puedo", session: null,
  }).catch(() => {});

  if (accion === "si") {

    const respuesta = `¡Perfecto! Su visita queda confirmada para mañana a las ${horaVisita}. ¡Hasta entonces! 😊`;
    await sendText(from, respuesta);
    registrarEnMemoria(fromE164, visita?.name, respuesta);

    const aviso =
      `✅ *Cliente confirmó su visita de mañana*\n\n` +
      `👤 ${nombreCliente}\n` +
      `🕐 ${horaVisita}\n` +
      (zonaVisita ? `📍 ${zonaVisita}\n` : "") +
      `📱 ${fromE164}`;

    for (const sup of SUPERVISORES_CONFIRMACION) {
      sendText(sup, aviso).catch(() => {});
    }

  } else {

    // v3 (24 sept 2026): el cliente puede reprogramar solo — Sasha le
    // muestra las fechas libres si responde "reprogramar" (index.js v26).
    const respuesta =
      `Entendido, gracias por avisar 🙏\n\n` +
      `Si desea, puede reprogramarla ahora mismo: escríbame *reprogramar* y le muestro las fechas disponibles. ` +
      `Si prefiere, nuestro equipo también le puede escribir para coordinar.`;
    await sendText(from, respuesta);
    registrarEnMemoria(fromE164, visita?.name, respuesta);

    const aviso =
      `⚠️ *Cliente NO puede recibir la visita de mañana*\n\n` +
      `👤 ${nombreCliente}\n` +
      `🕐 ${horaVisita}\n` +
      (zonaVisita ? `📍 ${zonaVisita}\n` : "") +
      `📱 ${fromE164}\n\n` +
      `Se le ofreció reprogramar solo (escribiendo "reprogramar"). Si no lo hace, hay que contactarlo.`;

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
