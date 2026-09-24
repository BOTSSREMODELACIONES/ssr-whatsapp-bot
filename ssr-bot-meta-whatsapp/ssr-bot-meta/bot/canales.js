/**
 * ============================================================
 * canales.js — Envío multicanal para index.js
 * SS Remodelaciones — Sasha Bot
 * ============================================================
 * index.js antes importaba directo de messenger.js (solo WhatsApp).
 * Ahora importa de acá: mismas funciones, mismos parámetros, pero si el
 * destino es "ig_..." (Instagram) o "fb_..." (Messenger) el mensaje sale
 * por metaMensajeria.js. Todo lo demás sigue yendo a WhatsApp sin cambios.
 * ============================================================
 */

const wa = require("./messenger");
const meta = require("./metaMensajeria");

function esMeta(destino) {
  return meta.esDestinoMeta(destino);
}

module.exports = Object.assign({}, wa, {
  sendText(destino, texto, ...resto) {
    return esMeta(destino) ? meta.enviarTexto(destino, texto) : wa.sendText(destino, texto, ...resto);
  },

  sendList(destino, texto, botonTexto, secciones, ...resto) {
    return esMeta(destino)
      ? meta.enviarLista(destino, texto, secciones)
      : wa.sendList(destino, texto, botonTexto, secciones, ...resto);
  },

  sendButtons(destino, texto, botones, ...resto) {
    return esMeta(destino)
      ? meta.enviarBotones(destino, texto, botones)
      : wa.sendButtons(destino, texto, botones, ...resto);
  },

  // Los ids de Instagram/Messenger no son de WhatsApp: no se marcan como leídos.
  markRead(messageId, ...resto) {
    if (!messageId || !/^wamid\./.test(String(messageId))) return Promise.resolve();
    return wa.markRead(messageId, ...resto);
  },

  // Un mediaId de WhatsApp no se puede reenviar a Instagram/Messenger.
  sendMediaById(destino, ...resto) {
    if (esMeta(destino)) return Promise.resolve(null);
    return wa.sendMediaById(destino, ...resto);
  },
});
