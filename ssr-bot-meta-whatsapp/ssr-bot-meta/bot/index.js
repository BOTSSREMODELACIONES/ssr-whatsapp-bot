const { get, update, addMsg, reset } = require("./state");
const { ask } = require("./claude");
const { sendText, markRead, downloadMedia, sendMediaById } = require("./messenger");
const { createVisitEvent, getAvailableSlots } = require("./calendar");
const { sendVisitConfirmation } = require("./email");
const { upsertLead, registerVisit } = require("./crm");
const KNOWLEDGE = require("./knowledge");
const memoria = require("./memoria");
const outbound = require("./outbound");
const { guardarSolicitante, guardarProveedor, PASOS_SOLICITANTE, PASOS_PROVEEDOR } = require("./rrhh");
const finanzas = require("./finanzas");

// ── Administradores / Supervisores ───────────────────────────────────────────

const SUPERVISORES = [
  "+50683091817", // Darwin — Gerente General
  "+50670068477", // Darwin (segundo número)
  "+50671981370", // Melvin — Encargado de proyectos
];

// URL del Apps Script para aprobación/rechazo de vales
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbztWIf5eBN2GQXCQCvw53EmBwMdoUz_ZTrIUSTyQupq_wul4I_T9Mo5sGMi1ooMA-kk/exec";

// Números exactos a ignorar completamente
const IGNORAR = [
  "+5215571965946", // Estafador México
];

// Prefijos de país a bloquear por seguridad
const IGNORAR_PREFIJOS = [
  "+57", // Colombia
  "+52", // México
];

// ── Interpretar comando de supervisor con Claude ──────────────────────────────

async function interpretarComandoAdmin(text) {
  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    let contextoClientes = "";
    try {
      const clientes = await memoria.listarClientes();
      if (clientes && clientes.length > 0) {
        const recientes = clientes.slice(-8).reverse();
        contextoClientes = "\n\nCLIENTES RECIENTES EN MEMORIA (más reciente primero):\n" +
          recientes.map(r => {
            const ult = r[5] ? new Date(r[5]).toLocaleDateString("es-CR", { timeZone: "America/Costa_Rica" }) : "—";
            return ` • ${r[2] || r[1] || "?"} | Tel: ${r[0]} | Últ. actividad: ${ult}`;
          }).join("\n");
      }
    } catch (e) {
      console.warn("⚠️ interpretarComandoAdmin: no pude cargar clientes recientes:", e.message);
    }

    const response = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      system: `Sos el sistema de interpretación de comandos de Sasha para los administradores de SS Remodelaciones.

Tu trabajo es clasificar el mensaje del administrador y extraer los parámetros.

${contextoClientes}

REGLA IMPORTANTE — Referencias contextuales:
Cuando el admin dice "ese cliente", "el cliente", "la señora", "el señor", "el de antes",
"el que estaba agendando", "el último cliente", etc. — debés resolver a quién se refiere
usando la lista de clientes recientes de arriba. Elegí el cliente con actividad más reciente.

REGLA CRÍTICA — Comandos con número de teléfono explícito:
Si el mensaje menciona un número de teléfono (ej: +50688950719, 88950719, del +506XXXXXXX)
junto con una instrucción de qué decirle, SIEMPRE es accion="outbound".
El destino debe ser ese número de teléfono EXACTAMENTE como aparece.
NUNCA clasifiques como "historial" un mensaje que pide enviarle algo a alguien.

Respondé SOLO con un JSON válido (sin markdown, sin explicaciones):
{
  "accion": "outbound" | "historial" | "info_cliente" | "listar" | "buscar" | "desconocido",
  "destino": "nombre o número del cliente resuelto (para outbound)",
  "mensaje": "instrucción de lo que hay que comunicarle al cliente (para outbound)",
  "busqueda": "término de búsqueda (para historial, info, buscar)"
}

Ejemplos:
- "envíale a María que mañana es la visita" → outbound, destino=María
- "avísale a ese cliente que para mañana no hay, que para el viernes" → outbound, destino=cliente más reciente de la lista
- "manda a 88887777: hola" → outbound, destino=88887777
- "Sasha dile a este cliente Wendy Arce del +50688950719 que tenemos disponibilidad para el martes a las 9am" → outbound, destino=+50688950719, mensaje=que tenemos disponibilidad para el martes a las 9am
- "dile al cliente del +50688950719 que..." → outbound, destino=+50688950719
- "qué habló María González" → historial, busqueda=María González
- "pasame los datos de Gustavo" → info_cliente, busqueda=Gustavo
- "listar clientes" → listar`,
      messages: [{ role: "user", content: text }],
    });

    const rawText = response.content[0]?.text || "{}";
    const clean = rawText.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (err) {
    console.warn("⚠️ interpretarComandoAdmin error:", err.message);
    return { accion: "desconocido" };
  }
}

async function handleMessage(from, text, messageId, mediaIds = null) {
  if (messageId) markRead(messageId).catch(() => {});

  const normalized = (text || "").trim();
  const session = get(from);
  const fromE164 = from.startsWith("+") ? from : `+${from}`;

  if (normalized === "/reset") {
    reset(from);
    await sendText(from, "🔄 Reiniciado.");
    return;
  }

  if (IGNORAR.includes(fromE164) || IGNORAR.includes(from)) return;
  if (IGNORAR_PREFIJOS.some(p => fromE164.startsWith(p) || from.startsWith(p))) {
    console.log(`🚫 Mensaje bloqueado de país restringido: ${from}`);
    return;
  }

  // ── MODO SUPERVISOR / ADMINISTRADOR ─────────────────────────────────────────

  const esSupervisor = SUPERVISORES.includes(fromE164) || SUPERVISORES.includes(from);

  if (esSupervisor && normalized) {

    // 1. Menú de ayuda
    if (/^(ayuda|help|\?|menu|comandos)$/i.test(normalized.trim())) {
      await sendText(from, [
        "🤖 *Sasha — Panel Admin*",
        "",
        "Podés escribirme en lenguaje natural, por ejemplo:",
        "",
        "📤 *Enviar mensajes:*",
        " _envíale a María González que mañana es la visita_",
        " _manda a +50688887777: confirmamos cita_",
        " _escríbele a Juan Pérez, dile que la cotización está lista_",
        " _Sasha dile a Wendy del +50688950719 que tenemos disponibilidad el martes_",
        "",
        "📋 *Consultar clientes:*",
        " _listar clientes_",
        " _pasame los datos de Gustavo_",
        " _info de +50688887777_",
        "",
        "💬 *Historial WhatsApp:*",
        " _qué habló María González_",
        " _historial de Juan Pérez_",
        " _buscar remodelación cocina_",
        " _fotos de Carlos_",
        "",
        "💰 *Registrar gastos e ingresos:*",
        " _pagué 125 mil de gasolina para Sergio_",
        " _compré materiales en EPA por 340 mil para Karim_",
        " _me pagaron 500 mil de adelanto del proyecto 044_",
        " _le pagué a Melvin 80 mil de planilla_",
        " _compré tornillos para inventario 15 mil_",
        "",
        "💵 *Vales de trabajadores:*",
        " _aprobar vale Darwin Guillon_",
        " _rechazar vale Melvin_",
      ].join("\n"));
      return;
    }

    // ── 1.3 APROBAR / RECHAZAR VALE ──────────────────────────────────────────
    const _aprobarMatch = normalized.match(/^aprobar vale\s+(.+)$/i);
    const _rechazarMatch = normalized.match(/^rechazar vale\s+(.+)$/i);

    if (_aprobarMatch || _rechazarMatch) {
      const accion = _aprobarMatch ? "aprobar" : "rechazar";
      const nombre = (_aprobarMatch || _rechazarMatch)[1].trim();
      try {
        const urlReq = `${APPS_SCRIPT_URL}?action=${accion}&nombre=${encodeURIComponent(nombre)}`;
        await httpGetWithRedirects(urlReq);
        const emoji = accion === "aprobar" ? "✅" : "❌";
        await sendText(from,
          `${emoji} Vale de *${nombre}* ${accion === "aprobar" ? "aprobado" : "rechazado"} correctamente.\n\n` +
          `La ganancia neta de la semana fue actualizada.`
        );
      } catch (err) {
        console.error("❌ Error vale:", err.message);
        await sendText(from, `❌ Error al ${accion} el vale. Verificá manualmente en la planilla VALES_APP.`);
      }
      return;
    }

    // ── 1.5 MÓDULO FINANCIERO ─────────────────────────────────────────────────
    const respuestaFinanciera = await finanzas.procesarComandoFinanciero(normalized);
    if (respuestaFinanciera) {
      await sendText(from, respuestaFinanciera);
      return;
    }

    // ── DETECCIÓN RÁPIDA: comando outbound con número de teléfono explícito ──
    // Si el mensaje del admin incluye un número de teléfono y palabras como
    // "dile", "dísele", "avísale", "manda", "escríbele", etc., lo procesamos
    // directamente como outbound sin pasar por procesarComandoOutbound (que
    // a veces no reconoce este formato) ni interpretarComandoAdmin.
    const telefonoEnMensaje = normalized.match(/\+?506\d{8}|\+?\d{8,15}/);
    const esComandoOutboundDirecto = telefonoEnMensaje &&
      /dile|disele|avisale|avísale|dísele|manda|escríbele|escribele|enviале|enviale|comunícale|comunicale|informa|notifica/i.test(normalized);

    if (esComandoOutboundDirecto) {
      // Extraer número limpio (asegurar formato E164 con +506)
      let telRaw = telefonoEnMensaje[0].replace(/\D/g, "");
      if (telRaw.length === 8) telRaw = "506" + telRaw;
      const telDestino = telRaw;

      // Extraer el mensaje a enviar: todo lo que viene después del número
      // o después de palabras clave como "que", "diciéndole", etc.
      const despuesDelNumero = normalized.replace(/\+?506\d{8}|\+?\d{10,15}/, "").trim();
      const instruccion = despuesDelNumero
        .replace(/^(sasha\s+)?(dile|avisale|avísale|manda|escríbele|escribele|enviale|enviале|comunícale|notifica)\s+(a\s+)?(este\s+cliente\s+)?(\w+\s+\w+\s+)?(del?\s+)?/i, "")
        .replace(/^que\s+/i, "")
        .trim();

      // Buscar nombre del cliente en CRM para personalizar
      let clientName = telDestino;
      try {
        const crmRows = await memoria.buscarClienteEnCRM(telDestino);
        if (crmRows && crmRows.length > 0 && crmRows[0][2]) clientName = crmRows[0][2];
      } catch { /* no crítico */ }

      // También intentar extraer nombre del propio mensaje del admin
      const nombreEnMensaje = normalized.match(/(?:cliente\s+)([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)+)/);
      if (nombreEnMensaje) clientName = nombreEnMensaje[1];

      const mensajeProfesional = await outbound.componerMensajeProfesional(instruccion || normalized, clientName);
      const resultado = await outbound.enviarProactivo(telDestino, mensajeProfesional);

      if (resultado.ok) {
        memoria.guardarMensaje({ phone: "+" + telDestino, clientName, direction: "out", type: "text", content: `[OUTBOUND] ${mensajeProfesional}` }).catch(() => {});
        await sendText(from,
          `✅ *Mensaje enviado*\n📱 +${telDestino}\n\n` +
          `📝 *Sasha redactó:*\n${mensajeProfesional}`
        );
      } else {
        await sendText(from, `❌ Error al enviar a +${telDestino}: ${resultado.error}`);
      }
      return;
    }

    // 2. Intentar outbound (patrones directos)
    const respuestaOutbound = await outbound.procesarComandoOutbound(normalized);
    if (respuestaOutbound) {
      await sendText(from, respuestaOutbound);
      return;
    }

    // 3. Intentar memoria/CRM (patrones directos)
    const respuestaMemoria = await memoria.procesarConsultaMemoria(normalized);
    if (respuestaMemoria) {
      await sendText(from, respuestaMemoria);
      return;
    }

    // 4. Fallback: usar Claude para interpretar lenguaje natural
    const interpretacion = await interpretarComandoAdmin(normalized);
    console.log(`🧠 Admin interpret: ${JSON.stringify(interpretacion)}`);

    if (interpretacion.accion === "outbound" && interpretacion.destino && interpretacion.mensaje) {
      const telefono = await outbound.resolverTelefono(interpretacion.destino);
      if (!telefono) {
        await sendText(from, `❌ No encontré a *"${interpretacion.destino}"* en los clientes.\nIntentá con el número: _enviar a +506XXXXXXXX: [instrucción]_`);
      } else {
        let clientName = interpretacion.destino;
        try {
          const crmRows = await memoria.buscarClienteEnCRM(interpretacion.destino);
          if (crmRows && crmRows.length > 0 && crmRows[0][2]) clientName = crmRows[0][2];
        } catch { /* no critical */ }

        const mensajeProfesional = await outbound.componerMensajeProfesional(interpretacion.mensaje, clientName);
        const resultado = await outbound.enviarProactivo(telefono, mensajeProfesional);

        if (resultado.ok) {
          memoria.guardarMensaje({ phone: "+" + telefono, clientName, direction: "out", type: "text", content: `[OUTBOUND] ${mensajeProfesional}` }).catch(() => {});
          await sendText(from,
            `✅ *Mensaje enviado*\n📱 +${telefono}\n\n` +
            `📝 *Sasha redactó:*\n${mensajeProfesional}`
          );
        } else {
          await sendText(from, `❌ Error al enviar: ${resultado.error}`);
        }
      }
      return;
    }

    if (interpretacion.accion === "historial" && interpretacion.busqueda) {
      const resp = await memoria.procesarConsultaMemoria(`historial ${interpretacion.busqueda}`);
      await sendText(from, resp || `📭 No encontré conversaciones de "${interpretacion.busqueda}".`);
      return;
    }

    if (interpretacion.accion === "info_cliente" && interpretacion.busqueda) {
      const resp = await memoria.procesarConsultaMemoria(`info de ${interpretacion.busqueda}`);
      await sendText(from, resp || `📭 No encontré a "${interpretacion.busqueda}" en el CRM.`);
      return;
    }

    if (interpretacion.accion === "listar") {
      const resp = await memoria.procesarConsultaMemoria("listar clientes");
      await sendText(from, resp || "📭 No hay clientes en el CRM aún.");
      return;
    }

    if (interpretacion.accion === "buscar" && interpretacion.busqueda) {
      const resp = await memoria.procesarConsultaMemoria(`buscar ${interpretacion.busqueda}`);
      await sendText(from, resp || `📭 Sin resultados para "${interpretacion.busqueda}".`);
      return;
    }

    // 5. No reconocido
    await sendText(from, "No entendí ese comando. Escribí *ayuda* para ver ejemplos de lo que puedo hacer.");
    return;
  }

  // ── Registrar timestamp de mensaje entrante ───────────────────────────────
  outbound.registrarMensajeEntrante(from);

  if (session.escalated) return;

  // ── MODO SOLICITANTE DE TRABAJO ──────────────────────────────────────────────
  if (session.modo === "solicitante") {
    await handleRRHHFlow(from, normalized, session, "solicitante");
    return;
  }

  // ── MODO PROVEEDOR ───────────────────────────────────────────────────────────
  if (session.modo === "proveedor") {
    await handleRRHHFlow(from, normalized, session, "proveedor");
    return;
  }

  try {
    // ── Descargar imágenes ────────────────────────────────────────────────────
    let imageDataArray = [];
    if (mediaIds) {
      const ids = Array.isArray(mediaIds) ? mediaIds : [mediaIds];
      console.log(`🖼️ Descargando ${ids.length} imagen(es) de ${from}...`);
      const results = await Promise.allSettled(ids.map(id => downloadMedia(id)));
      imageDataArray = results
        .map((r, i) => {
          if (r.status === "fulfilled" && r.value) {
            console.log(`✅ Imagen ${i+1}/${ids.length} (${r.value.mimeType})`);
            return r.value;
          }
          console.error(`❌ Error img ${i+1}:`, r.reason?.message);
          return null;
        })
        .filter(Boolean);
    }

    const imageData = imageDataArray.length === 0 ? null
      : imageDataArray.length === 1 ? imageDataArray[0]
      : imageDataArray;

    if (!normalized && imageDataArray.length === 0) return;

    const historyText = normalized ||
      (imageDataArray.length === 1 ? "[Cliente envió una foto]" : `[Cliente envió ${imageDataArray.length} fotos]`);

    addMsg(from, "user", historyText);

    // ── Memoria ───────────────────────────────────────────────────────────────
    if (!esSupervisor) {
      const clientName = session.name || null;
      if (normalized) {
        memoria.guardarMensaje({ phone: fromE164, clientName, direction: "in", type: "text", content: normalized, session }).catch(() => {});
      }
      if (imageDataArray.length > 0) {
        const ids = Array.isArray(mediaIds) ? mediaIds : [mediaIds];
        imageDataArray.forEach((imgData, i) => {
          const mediaId = ids[i] || "";
          memoria.guardarMedia(imgData.data, imgData.mimeType, fromE164, clientName)
            .then(driveUrl => memoria.guardarMensaje({ phone: fromE164, clientName, direction: "in", type: "image", content: "[Foto enviada por el cliente]", mediaId, driveUrl: driveUrl || "", session }).catch(() => {}))
            .catch(() => memoria.guardarMensaje({ phone: fromE164, clientName, direction: "in", type: "image", content: "[Foto enviada por el cliente]", mediaId, driveUrl: "", session }).catch(() => {}));
        });
      }
    }

    // ── Detectar día/fecha para disponibilidad ────────────────────────────────
    const dayMentioned = detectDayOrDate(normalized);
    let availabilityContext = "";

    if (dayMentioned && dayMentioned !== session.slots_shown) {
      update(from, { slots_shown: dayMentioned });

      const DIAS_NO_DISPONIBLES = ["miercoles", "jueves", "sabado", "domingo"];

      if (DIAS_NO_DISPONIBLES.includes(dayMentioned)) {
        availabilityContext = `\n\n[SISTEMA: El cliente pidió ${dayMentioned} pero SS Remodelaciones NO realiza visitas los miércoles ni jueves (tampoco sábados ni domingos). Debes decirle claramente que ese día no hay disponibilidad y ofrecerle el próximo día hábil: lunes, martes o viernes. Sé amable y directo — NO digas que vas a "verificar", ya sabes la respuesta.]`;

      } else if (dayMentioned === "cualquiera") {
        // ── FIX Bug 1: cliente acepta cualquier día ──────────────────────────
        // Consultar los 3 días disponibles en paralelo y presentar de una vez
        const [slotsLunes, slotsMartes, slotsViernes] = await Promise.all([
          getAvailableSlots("lunes"),
          getAvailableSlots("martes"),
          getAvailableSlots("viernes"),
        ]);

        const diasConSlots = [];
        if (slotsLunes.length)   diasConSlots.push({ dia: "lunes",   slots: slotsLunes });
        if (slotsMartes.length)  diasConSlots.push({ dia: "martes",  slots: slotsMartes });
        if (slotsViernes.length) diasConSlots.push({ dia: "viernes", slots: slotsViernes });

        if (diasConSlots.length === 0) {
          availabilityContext = `\n\n[SISTEMA: El cliente acepta cualquier día pero no hay disponibilidad esta semana en lunes, martes ni viernes. Informa amablemente y ofrécele coordinar para la próxima semana.]`;
        } else {
          const resumen = diasConSlots.map(d => {
            const slotsText = d.slots.map(s => {
              const [h, m] = s.split(":");
              const hNum = parseInt(h);
              const h12 = hNum > 12 ? hNum - 12 : hNum;
              return `${h12}:${m} ${hNum >= 12 ? "p.m." : "a.m."}`;
            }).join(", ");
            return `${d.dia}: ${slotsText}`;
          }).join(" | ");
          availabilityContext = `\n\n[SISTEMA: El cliente acepta cualquier día disponible. Disponibilidad verificada — NO digas que vas a verificar, ya tienes los datos: ${resumen}. Preséntale estos horarios directamente y que elija el que prefiera.]`;
        }

      } else {
        const slots = await getAvailableSlots(dayMentioned);
        if (slots.length === 0) {
          availabilityContext = `\n\n[SISTEMA: El cliente pidió ${dayMentioned} pero NO hay slots disponibles ese día. Explícale amablemente y ofrécele los otros días disponibles: lunes, martes o viernes.]`;
        } else {
          const slotsText = slots.map(s => {
            const [h, m] = s.split(":");
            const hNum = parseInt(h);
            const h12 = hNum > 12 ? hNum - 12 : hNum;
            return `${h12}:${m} ${hNum >= 12 ? "p.m." : "a.m."}`;
          }).join(", ");
          availabilityContext = `\n\n[SISTEMA: Slots disponibles para ${dayMentioned}: ${slotsText}. Ofrece SOLO estos horarios al cliente. La disponibilidad ya fue verificada — NO digas que vas a verificarla. Si el cliente ya eligió uno, procede INMEDIATAMENTE a pedirle la ubicación.]`;
        }
      }
    }

    // ── Llamar a Claude ───────────────────────────────────────────────────────
    const rawResponse = await ask(session.history.slice(0, -1), normalized + availabilityContext, imageData);
    const { cleanMessage, flag, flagData } = parseFlags(rawResponse);

    await sendText(from, cleanMessage);
    addMsg(from, "assistant", cleanMessage);

    if (!esSupervisor) {
      memoria.guardarMensaje({ phone: fromE164, clientName: session.name || null, direction: "out", type: "text", content: cleanMessage, session }).catch(() => {});
    }

    // ── Monitor supervisores ──────────────────────────────────────────────────
    const clientLabel = session.name ? `${session.name} (${from})` : from;
    const clientMsgLabel = imageDataArray.length > 0
      ? `📷 [${imageDataArray.length} foto(s)]${normalized ? ` "${normalized}"` : ""}`
      : normalized;

    const monitorMsg = `👁️ *Conversación en tiempo real*\n👤 Cliente: ${clientLabel}\n\n💬 *Cliente:* ${clientMsgLabel}\n🤖 *Sasha:* ${cleanMessage}`;

    for (const supervisor of SUPERVISORES) {
      sendText(supervisor, monitorMsg).catch(err => console.error(`❌ Monitor [${supervisor}]: ${err.message}`));
    }

    if (mediaIds) {
      const ids = Array.isArray(mediaIds) ? mediaIds : [mediaIds];
      for (const mediaId of ids) {
        for (const supervisor of SUPERVISORES) {
          sendMediaById(supervisor, mediaId, "image", `📷 Foto de cliente: ${clientLabel}`).catch(() => {});
        }
      }
    }

    // ── Procesar flags ────────────────────────────────────────────────────────
    if (flag === "ESCALAR") {
      update(from, { escalated: true });
      await sendText(from, `📞 Le conecto ahora con *${KNOWLEDGE.empresa.encargado}* de nuestro equipo.`);
      await notifyAllSupervisors(from, session, normalized, "escalacion");

    } else if (flag === "LEAD") {
      const [name, project, zone] = (flagData || "").split("|");
      const updated = update(from, {
        name: name?.trim() || session.name,
        project_desc: project?.trim() || session.project_desc,
        zone: zone?.trim() || session.zone,
      });
      if (!session.lead_saved) {
        update(from, { lead_saved: true });
        logLead(from, updated);
        upsertLead({ ...updated, phone: from }).catch(() => {});
      }

    } else if (flag === "VISITA") {
      const [name, project, zone, day, hour, ubicacion, email] = (flagData || "").split("|");
      const updated = update(from, {
        name: name?.trim() || session.name,
        project_desc: project?.trim() || session.project_desc,
        zone: zone?.trim() || session.zone,
        visit_day: day?.trim() || "a coordinar",
        visit_hour: hour?.trim() || "09:00",
        waze_link: ubicacion?.trim() || "",
        client_email: email?.trim() || "",
        visit_confirmed: true,
        lead_saved: true,
      });

      const visitHour = updated.visit_hour || "09:00";
      const [hh, mm] = visitHour.split(":");
      const hourNum = parseInt(hh);
      const hour12 = hourNum > 12 ? hourNum - 12 : hourNum === 0 ? 12 : hourNum;
      let timeStr = `${hour12}:${mm} ${hourNum >= 12 ? "p.m." : "a.m."}`;
      let dateStr = updated.visit_day;

      try {
        const eventData = await createVisitEvent({
          name: updated.name,
          phone: from,
          project: updated.project_desc,
          zone: updated.zone,
          day: updated.visit_day,
          hour: updated.visit_hour,
          wazeLink: updated.waze_link,
          clientEmail: updated.client_email,
        });
        dateStr = eventData.startDate.toLocaleDateString("es-CR", {
          weekday: "long", day: "numeric", month: "long",
          timeZone: "America/Costa_Rica",
        });
        console.log(`📅 Visita agendada: ${eventData.eventLink}${eventData.rescheduled ? " (reagendada)" : ""}`);
      } catch (calErr) {
        console.error("❌ Error Calendar:", calErr.message);
      }

      try {
        await sendVisitConfirmation({
          name: updated.name, phone: from, project: updated.project_desc,
          zone: updated.zone, day: updated.visit_day, hour: updated.visit_hour,
          wazeLink: updated.waze_link, clientEmail: updated.client_email,
          dateStr, timeStr,
        });
      } catch (emailErr) {
        console.error("❌ Error email:", emailErr.message);
      }

      registerVisit({ ...updated, phone: from }).catch(() => {});
      await notifyAllSupervisors(from, updated, normalized, "visita_solicitada");
      logLead(from, updated, "visita_solicitada");
      await sendText(from, `✅ ¡Listo! Su cita quedó agendada para el *${dateStr} a las ${timeStr}*. Le llegará una confirmación por correo 📅`);

    } else if (flag === "SOLICITANTE") {
      update(from, { modo: "solicitante", rrhh_paso: 0, rrhh_data: {} });
      const msg = `Gracias por su interés en trabajar con *SS Remodelaciones* 👷\n\nPara registrar su información en Recursos Humanos, le haré unas preguntas. Le estaremos llamando cuando tengamos nuevos proyectos disponibles.\n\n${PASOS_SOLICITANTE[0].pregunta}`;
      await sendText(from, msg);
      addMsg(from, "assistant", msg);

    } else if (flag === "PROVEEDOR") {
      update(from, { modo: "proveedor", rrhh_paso: 0, rrhh_data: {} });
      const msg = `Gracias por contactarnos 🏗️\n\nPara registrar su empresa en nuestra base de proveedores de *SS Remodelaciones*, le haré unas preguntas breves.\n\n${PASOS_PROVEEDOR[0].pregunta}`;
      await sendText(from, msg);
      addMsg(from, "assistant", msg);
    }

  } catch (err) {
    console.error("❌ Error:", err.message);
    await sendText(from, `Tuve un problema técnico 😔 Por favor escríbale directamente a *${KNOWLEDGE.empresa.encargado}* al ${KNOWLEDGE.empresa.whatsapp_melvin}.`);
  }
}

// ── Flujo RRHH / Proveedores ──────────────────────────────────────────────────

async function handleRRHHFlow(from, text, session, tipo) {
  const pasos = tipo === "solicitante" ? PASOS_SOLICITANTE : PASOS_PROVEEDOR;
  const paso = session.rrhh_paso || 0;
  const data = { ...(session.rrhh_data || {}) };

  if (pasos[paso]?.campo && text) {
    data[pasos[paso].campo] = text;
    update(from, { rrhh_data: data });
  }

  const siguientePaso = paso + 1;
  if (siguientePaso < pasos.length) {
    update(from, { rrhh_paso: siguientePaso });
    const msg = pasos[siguientePaso].pregunta;
    await sendText(from, msg);
    addMsg(from, "assistant", msg);
    return;
  }

  update(from, { modo: null, rrhh_paso: 0, rrhh_data: {} });

  if (tipo === "solicitante") {
    await guardarSolicitante({
      phone: from, nombre: data.nombre, cedula: data.cedula,
      telefono: data.telefono, direccion: data.direccion,
      habilidad: data.habilidad, curriculum: data.curriculum,
    });
    const msg = `✅ Listo, registré su información con éxito.\n\nRecuerde que al ser contactado/a deberá presentar su *hoja de delincuencia* actualizada.\n\nLe estaremos llamando cuando tengamos proyectos disponibles. ¡Gracias por su interés en SS Remodelaciones! 🙌`;
    await sendText(from, msg);
    for (const sup of SUPERVISORES) {
      sendText(sup, `👷 *Nuevo solicitante de trabajo*\n\n📱 ${from}\n👤 ${data.nombre||"—"}\n🪪 Cédula: ${data.cedula||"—"}\n📞 ${data.telefono||"—"}\n📍 ${data.direccion||"—"}\n🔧 ${data.habilidad||"—"}\n📋 ${data.curriculum||"—"}\n\n_Sasha — Bot SSR_`).catch(() => {});
    }
  } else {
    await guardarProveedor({
      phone: from, empresa: data.empresa, contacto: data.contacto,
      email: data.email, telefono: data.telefono, sector: data.sector,
    });
    const msg = `✅ ¡Perfecto! Registramos la información de *${data.empresa||"su empresa"}* en nuestra base de proveedores.\n\nCuando tengamos necesidades en su área, los contactaremos. ¡Gracias! 🏗️`;
    await sendText(from, msg);
    for (const sup of SUPERVISORES) {
      sendText(sup, `🏭 *Nuevo proveedor registrado*\n\n📱 ${from}\n🏢 ${data.empresa||"—"}\n👤 ${data.contacto||"—"}\n📧 ${data.email||"—"}\n📞 ${data.telefono||"—"}\n🏗️ ${data.sector||"—"}\n\n_Sasha — Bot SSR_`).catch(() => {});
    }
  }
}

// ── Detectar día/fecha ────────────────────────────────────────────────────────
function detectDayOrDate(text) {
  const n = (text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  if (n.includes("lunes"))     return "lunes";
  if (n.includes("martes"))    return "martes";
  if (n.includes("miercoles")) return "miercoles";
  if (n.includes("jueves"))    return "jueves";
  if (n.includes("viernes"))   return "viernes";
  if (n.includes("sabado"))    return "sabado";
  if (n.includes("domingo"))   return "domingo";

  // ── FIX Bug 1: detectar "cualquier día" ──────────────────────────────────
  // Cuando el cliente dice que acepta cualquier día de los ofrecidos,
  // retornamos "cualquiera" para consultar todos los días disponibles de una.
  if (/cualquier|cualquiera|los tres|los 3|me da igual|el que sea|lo que haya|indistinto|cualquiera de los/i.test(n)) {
    return "cualquiera";
  }

  const DIAS = ["domingo","lunes","martes","miercoles","jueves","viernes","sabado"];
  const ahoraCR = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Costa_Rica" }));

  if (n.includes("hoy")) return DIAS[ahoraCR.getDay()];

  if (n.includes("pasado manana")) {
    const d = new Date(ahoraCR); d.setDate(d.getDate() + 2);
    return DIAS[d.getDay()];
  }

  if (n.includes("manana")) {
    const d = new Date(ahoraCR); d.setDate(d.getDate() + 1);
    return DIAS[d.getDay()];
  }

  const MONTHS = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  for (const mes of MONTHS) {
    const re = new RegExp(`(\\d{1,2})\\s+(?:de\\s+)?${mes}`, "i");
    const m = n.match(re);
    if (m) return `${m[1]} de ${mes}`;
  }

  const m2 = n.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (m2) return `${m2[1]}/${m2[2]}`;

  return null;
}

// ── Parsear flags de Claude ───────────────────────────────────────────────────
function parseFlags(response) {
  const flagRegex = /\[(ESCALAR|LEAD:([^\]]*)|VISITA:([^\]]*)|SOLICITANTE|PROVEEDOR)\]\s*$/;
  const sistemaRegex = /\[SISTEMA:[\s\S]*?\]/g;
  const match = response.match(flagRegex);

  if (!match) return { cleanMessage: response.replace(sistemaRegex, "").trim(), flag: null, flagData: null };

  const cleanMessage = response.replace(flagRegex, "").replace(sistemaRegex, "").trim();
  const fullFlag = match[1];

  if (fullFlag === "ESCALAR")     return { cleanMessage, flag: "ESCALAR",     flagData: null };
  if (fullFlag === "SOLICITANTE") return { cleanMessage, flag: "SOLICITANTE", flagData: null };
  if (fullFlag === "PROVEEDOR")   return { cleanMessage, flag: "PROVEEDOR",   flagData: null };
  if (fullFlag.startsWith("LEAD:"))   return { cleanMessage, flag: "LEAD",   flagData: fullFlag.slice(5) };
  if (fullFlag.startsWith("VISITA:")) return { cleanMessage, flag: "VISITA", flagData: fullFlag.slice(7) };

  return { cleanMessage, flag: null, flagData: null };
}

// ── Notificar supervisores ────────────────────────────────────────────────────
async function notifyAllSupervisors(from, session, lastMsg, tipo) {
  const header = {
    visita_solicitada: "🏗️ NUEVA VISITA AGENDADA",
    escalacion:        "🚨 CLIENTE NECESITA ATENCIÓN",
  }[tipo] || "📋 NOTIFICACIÓN SSR Bot";

  const lines = [
    header, "",
    `📱 ${from}`,
    session.name          && `👤 ${session.name}`,
    session.project_desc  && `🏗️ ${session.project_desc}`,
    session.zone          && `📍 ${session.zone}`,
    session.visit_day     && `📅 Día: ${session.visit_day}`,
    session.visit_hour    && `🕐 Hora: ${session.visit_hour}`,
    session.waze_link     && `🗺️ Ubicación: ${session.waze_link}`,
    session.client_email  && `📧 Email: ${session.client_email}`,
    "", `💬 "${lastMsg}"`, "",
    "_Sasha — Bot SSR_",
  ].filter(Boolean).join("\n");

  const resultados = await Promise.allSettled(SUPERVISORES.map(num => sendText(num, lines)));
  resultados.forEach((r, i) => {
    if (r.status === "fulfilled") console.log(`✅ Supervisor [${SUPERVISORES[i]}] notificado [${tipo}]`);
    else console.error(`❌ Error notificando ${SUPERVISORES[i]}: ${r.reason?.message}`);
  });
}

// ── HTTP con seguimiento de redirecciones (para Apps Script) ─────────────────
async function httpGetWithRedirects(url, depth = 0) {
  if (depth > 5) throw new Error("Too many redirects");
  const lib = url.startsWith("https") ? require("https") : require("http");
  return new Promise((resolve, reject) => {
    lib.get(url, { headers: { "User-Agent": "SSR-Bot/1.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpGetWithRedirects(res.headers.location, depth + 1));
        return;
      }
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

function logLead(from, session, tipo = "lead") {
  console.log("📋 LEAD:", JSON.stringify({
    tipo, ts: new Date().toISOString(),
    phone: from, name: session.name||"—",
    project: session.project_desc||"—", zone: session.zone||"—",
    visit_day: session.visit_day||"—", visit_hour: session.visit_hour||"—",
    location: session.waze_link||"—", email: session.client_email||"—",
    visit: session.visit_confirmed||false,
  }));
}

module.exports = { handleMessage };
