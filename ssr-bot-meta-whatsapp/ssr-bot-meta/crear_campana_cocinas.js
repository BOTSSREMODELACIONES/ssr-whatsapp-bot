/**
 * crear_campana_cocinas.js
 * SS Remodelaciones — Campaña "Tu Cocina Nueva 2026"
 *
 * Ejecutar UNA VEZ desde el servidor Railway o localmente:
 *   node scripts/crear_campana_cocinas.js
 *
 * Crea en Meta Ads (todo en estado PAUSADO para revisión):
 *  ✅ Formulario de leads con 4 preguntas
 *  ✅ Campaña de captación de leads
 *  ✅ 2 conjuntos de anuncios (prospección + retargeting)
 *  ✅ Anuncio 1: imagen simple — Cocina 10 (el mejor resultado)
 *  ✅ Anuncio 2: imagen simple — copy aspiracional
 *  ✅ Anuncio 3: carrusel 10 fotos antes/durante/después
 *
 * Variables de entorno necesarias:
 *  FB_PAGE_ACCESS_TOKEN, FB_PAGE_ID, META_AD_ACCOUNT_ID
 */

require("dotenv").config();

const TOKEN      = process.env.FB_PAGE_ACCESS_TOKEN;
const PAGE_ID    = process.env.FB_PAGE_ID;
const AD_ACCOUNT = process.env.META_AD_ACCOUNT_ID; // act_4393199180899525
const GRAPH      = "https://graph.facebook.com/v19.0";
const WEBHOOK_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/meta-lead`
  : "https://ssr-whatsapp-bot-production.up.railway.app/meta-lead";

// ── Fotos de Cocina Marilyn (Google Drive) ────────────────────────────────────
const FOTOS = [
  { id: "1MA3mb1x1sYDeq34k2g3vy92O3VCKkdP2", nombre: "Cocina 1", etapa: "ANTES" },
  { id: "1lLrYNEkXwgg-v_xPX0Ia2lFMHZ7y3cj1", nombre: "Cocina 2", etapa: "ANTES" },
  { id: "190ftEqgXWipipVuwPx9gP6CO2bufiKnG",  nombre: "Cocina 3", etapa: "ANTES" },
  { id: "1DJWXGblrKgrhV5B8qVLufob6AyTzRPCc",  nombre: "Cocina 4", etapa: "DURANTE" },
  { id: "1N2oTvm4ZJAPwneuuIYOGt8RqKuf5OO3-",  nombre: "Cocina 5", etapa: "DURANTE" },
  { id: "18Xb7HwPJJRC844b9YkeOtwfHJpXdQSdI",  nombre: "Cocina 6", etapa: "DESPUÉS" },
  { id: "1HrV9bvGUKtbzB5wL4r6NYTPi5Zr00-hx",  nombre: "Cocina 7", etapa: "DESPUÉS" },
  { id: "1FieYBKFNxKewhoc1Lfr7AubN8MwCHCMV",  nombre: "Cocina 8", etapa: "DESPUÉS" },
  { id: "1PMlSXppNHDA6jbw70wbHLCSeyg0dgbC2",  nombre: "Cocina 9", etapa: "DESPUÉS" },
  { id: "1jtgMPMFWxfZICOHbF_DuF1k-6vmNR2Jc",  nombre: "Cocina 10", etapa: "DESPUÉS" },
];

// ── Copies ────────────────────────────────────────────────────────────────────
const COPIES = {
  dolor: {
    mensaje: "¿Tu cocina sigue siendo la misma de hace 10 años?\n\nEn SS Remodelaciones Costa Rica diseñamos y fabricamos cocinas a medida. Desde el diseño hasta la instalación, nos encargamos de todo.\n\n✅ Materiales de primera calidad\n✅ Diseño 3D incluido en tu proyecto\n✅ Instalación garantizada\n✅ Visita de diagnóstico (costo reembolsable al contratar)",
    titular: "¿Tu cocina sigue siendo la misma de hace 10 años?",
    cta: "GET_QUOTE",
  },
  aspiracional: {
    mensaje: "La cocina que siempre soñaste, ahora sí es posible.\n\nEn SS Remodelaciones Costa Rica diseñamos y fabricamos cocinas a medida. Diseño 3D personalizado, materiales seleccionados y mano de obra experta. Tu cocina nueva en semanas, no en meses.\n\nEl costo de la visita de diagnóstico se descuenta al contratar 🏠",
    titular: "La cocina que siempre soñaste, ahora sí es posible",
    cta: "GET_QUOTE",
  },
  urgencia: {
    mensaje: "Diseño 3D gratuito de tu cocina ideal — incluido en tu proyecto.\n\nEn SS Remodelaciones Costa Rica diseñamos y fabricamos cocinas a medida. Solo para proyectos en San José, Heredia, Alajuela y Cartago.\n\nEl costo de la visita se reembolsa al contratar. Sin compromisos. Sin letra pequeña.",
    titular: "Este mes: diseño 3D gratis de tu cocina",
    cta: "LEARN_MORE",
  },
};

// ── Helper: llamada a Meta API ────────────────────────────────────────────────
async function api(endpoint, method = "GET", body = null) {
  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH}/${endpoint}`;
  const opts = {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
  };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(url, opts);
  const data = await res.json();
  if (data.error) throw new Error(`Meta API [${endpoint}]: ${data.error.message} (code ${data.error.code})`);
  return data;
}

// ── Helper: sleep ─────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 1. Subir imágenes a Meta ──────────────────────────────────────────────────
async function subirImagenes() {
  console.log("\n📸 Subiendo imágenes a Meta Ads...");
  const hashes = {};

  for (const foto of FOTOS) {
    try {
      const driveUrl = `https://drive.google.com/uc?export=download&id=${foto.id}`;
      const result   = await api(`${AD_ACCOUNT}/adimages`, "POST", { url: driveUrl });
      const hash     = Object.values(result.images)[0]?.hash;
      if (!hash) throw new Error("No hash recibido");
      hashes[foto.nombre] = hash;
      console.log(`  ✅ ${foto.nombre} (${foto.etapa}) → hash: ${hash.slice(0, 8)}...`);
      await sleep(500); // respetar rate limit
    } catch (err) {
      console.error(`  ❌ Error subiendo ${foto.nombre}:`, err.message);
    }
  }
  return hashes;
}

// ── 2. Crear formulario de leads ──────────────────────────────────────────────
async function crearFormulario() {
  console.log("\n📋 Creando formulario de leads...");

  const form = await api(`${PAGE_ID}/leadgen_forms`, "POST", {
    name: "Formulario Cocinas SSR 2026",
    locale: "es_LA",
    questions: [
      { type: "FULL_NAME" },
      { type: "PHONE" },
      {
        type:       "CUSTOM",
        label:      "¿Qué necesitás?",
        field_type: "SELECT",
        options:    [
          { value: "Cocina a medida" },
          { value: "Remodelación completa de cocina" },
          { value: "Muebles modulares instalados" },
          { value: "No sé aún, quiero asesoría" },
        ],
      },
      {
        type:       "CUSTOM",
        label:      "Zona",
        field_type: "SELECT",
        options:    [
          { value: "San José" },
          { value: "Heredia" },
          { value: "Alajuela" },
          { value: "Cartago" },
          { value: "Otra zona" },
        ],
      },
    ],
    privacy_policy: {
      url:       "https://ssremodelaciones.com",
      link_text: "Política de privacidad de SS Remodelaciones",
    },
    follow_up_action_url: "https://wa.me/50671951695",
    thank_you_page: {
      title:    "¡Gracias por contactarnos!",
      body:     "Sasha de SS Remodelaciones se comunicará con usted por WhatsApp en menos de 1 hora para coordinar todos los detalles.",
      button_text: "Ver nuestros proyectos",
      website_url: "https://ssremodelaciones.com",
    },
    context_card: {
      style:       "LIST_STYLE",
      title:       "Cocinas a medida en Costa Rica",
      cover_photo: null,
      content:     [
        "Diseño 3D gratuito incluido en tu proyecto",
        "Instalación garantizada de principio a fin",
        "Visita de diagnóstico (reembolsable al contratar)",
        "Más de 50 proyectos terminados en el GAM",
      ],
    },
  });

  console.log(`  ✅ Formulario creado → ID: ${form.id}`);
  return form.id;
}

// ── 3. Crear campaña ──────────────────────────────────────────────────────────
async function crearCampana() {
  console.log("\n🚀 Creando campaña...");

  const campana = await api(`${AD_ACCOUNT}/campaigns`, "POST", {
    name:                 "Cocinas SSR — Tu Cocina Nueva 2026",
    objective:            "OUTCOME_LEADS",
    status:               "PAUSED",
    special_ad_categories: [],
  });

  console.log(`  ✅ Campaña creada → ID: ${campana.id}`);
  return campana.id;
}

// ── 4. Crear conjuntos de anuncios ────────────────────────────────────────────
async function crearAdSets(campanaId) {
  console.log("\n🎯 Creando conjuntos de anuncios...");

  const targeting = {
    geo_locations: {
      countries: ["CR"],
    },
    age_min: 28,
    age_max: 55,
    flexible_spec: [
      {
        interests: [
          { id: "6003107902433", name: "Home improvement" },
          { id: "6003348604839", name: "Interior design" },
          { id: "6003283445498", name: "Kitchen" },
          { id: "6003200358041", name: "Renovation" },
        ],
      },
    ],
    publisher_platforms: ["facebook", "instagram"],
    facebook_positions:  ["feed", "story"],
    instagram_positions: ["stream", "story"],
  };

  // AdSet 1 — Prospección ($140/mes = ~$4.67/día)
  const adset1 = await api(`${AD_ACCOUNT}/adsets`, "POST", {
    name:              "Prospección GAM — 28-55 — Remodelación",
    campaign_id:       campanaId,
    daily_budget:      467,    // en centavos USD
    billing_event:     "IMPRESSIONS",
    optimization_goal: "LEAD_GENERATION",
    destination_type:  "ON_AD",
    status:            "PAUSED",
    start_time:        new Date(Date.now() + 86400000).toISOString(), // mañana
    targeting,
  });
  console.log(`  ✅ AdSet Prospección → ID: ${adset1.id}`);

  // AdSet 2 — Retargeting ($60/mes = ~$2/día)
  const adset2 = await api(`${AD_ACCOUNT}/adsets`, "POST", {
    name:              "Retargeting — Visitaron perfil — GAM",
    campaign_id:       campanaId,
    daily_budget:      200,
    billing_event:     "IMPRESSIONS",
    optimization_goal: "LEAD_GENERATION",
    destination_type:  "ON_AD",
    status:            "PAUSED",
    start_time:        new Date(Date.now() + 86400000).toISOString(),
    targeting: {
      ...targeting,
      custom_audiences: [], // se puede agregar audiencia personalizada después
    },
  });
  console.log(`  ✅ AdSet Retargeting → ID: ${adset2.id}`);

  return { prospeccion: adset1.id, retargeting: adset2.id };
}

// ── 5. Crear creativos ────────────────────────────────────────────────────────
async function crearCreativos(hashes, formId) {
  console.log("\n🎨 Creando creativos...");

  const hashCocina10 = hashes["Cocina 10"];
  const hashCocina9  = hashes["Cocina 9"];

  if (!hashCocina10 || !hashCocina9) {
    throw new Error("No se pudieron obtener los hashes de las imágenes principales");
  }

  // Creativo 1 — Imagen simple — Copy Dolor (Cocina 10)
  const creativo1 = await api(`${AD_ACCOUNT}/adcreatives`, "POST", {
    name: "Creativo — Dolor — Cocina 10",
    object_story_spec: {
      page_id: PAGE_ID,
      link_data: {
        image_hash:  hashCocina10,
        link:        `https://www.facebook.com/${PAGE_ID}`,
        message:     COPIES.dolor.mensaje,
        name:        COPIES.dolor.titular,
        call_to_action: {
          type:  "GET_QUOTE",
          value: { lead_gen_form_id: formId },
        },
      },
    },
  });
  console.log(`  ✅ Creativo 1 (Dolor) → ID: ${creativo1.id}`);

  // Creativo 2 — Imagen simple — Copy Aspiracional (Cocina 9)
  const creativo2 = await api(`${AD_ACCOUNT}/adcreatives`, "POST", {
    name: "Creativo — Aspiracional — Cocina 9",
    object_story_spec: {
      page_id: PAGE_ID,
      link_data: {
        image_hash:  hashCocina9,
        link:        `https://www.facebook.com/${PAGE_ID}`,
        message:     COPIES.aspiracional.mensaje,
        name:        COPIES.aspiracional.titular,
        call_to_action: {
          type:  "GET_QUOTE",
          value: { lead_gen_form_id: formId },
        },
      },
    },
  });
  console.log(`  ✅ Creativo 2 (Aspiracional) → ID: ${creativo2.id}`);

  // Creativo 3 — Carrusel 10 fotos (Antes → Durante → Después)
  const etiquetas = {
    "ANTES":    ["Así estaba la cocina", "Cocina sin renovar", "El punto de partida"],
    "DURANTE":  ["El proceso de transformación", "En instalación"],
    "DESPUÉS":  ["El resultado final ✨", "Cocina a medida terminada", "Cada detalle cuenta", "Diseño personalizado", "Tu cocina puede ser así"],
  };
  const contadores = { "ANTES": 0, "DURANTE": 0, "DESPUÉS": 0 };

  const tarjetas = FOTOS.map(foto => {
    const hash = hashes[foto.nombre];
    if (!hash) return null;
    const idx   = contadores[foto.etapa]++;
    const titulo = etiquetas[foto.etapa][idx] || foto.etapa;
    return {
      link:       `https://www.facebook.com/${PAGE_ID}`,
      image_hash: hash,
      name:       titulo,
      description: foto.etapa === "DESPUÉS" ? "SS Remodelaciones Costa Rica" : "",
      call_to_action: {
        type:  "GET_QUOTE",
        value: { lead_gen_form_id: formId },
      },
    };
  }).filter(Boolean);

  const creativo3 = await api(`${AD_ACCOUNT}/adcreatives`, "POST", {
    name: "Creativo — Carrusel Antes/Durante/Después",
    object_story_spec: {
      page_id: PAGE_ID,
      link_data: {
        message:            COPIES.urgencia.mensaje,
        child_attachments:  tarjetas,
        multi_share_end_card: false,
      },
    },
  });
  console.log(`  ✅ Creativo 3 (Carrusel) → ID: ${creativo3.id}`);

  return { creativo1: creativo1.id, creativo2: creativo2.id, creativo3: creativo3.id };
}

// ── 6. Crear anuncios ─────────────────────────────────────────────────────────
async function crearAnuncios(adSets, creativos) {
  console.log("\n📣 Creando anuncios...");

  const ad1 = await api(`${AD_ACCOUNT}/ads`, "POST", {
    name:        "Anuncio 1 — Dolor — Imagen simple",
    adset_id:    adSets.prospeccion,
    creative:    { creative_id: creativos.creativo1 },
    status:      "PAUSED",
    tracking_specs: [{ action: ["offsite_conversion"], fb_pixel: [] }],
  });
  console.log(`  ✅ Anuncio 1 creado → ID: ${ad1.id}`);

  const ad2 = await api(`${AD_ACCOUNT}/ads`, "POST", {
    name:        "Anuncio 2 — Aspiracional — Imagen simple",
    adset_id:    adSets.prospeccion,
    creative:    { creative_id: creativos.creativo2 },
    status:      "PAUSED",
    tracking_specs: [{ action: ["offsite_conversion"], fb_pixel: [] }],
  });
  console.log(`  ✅ Anuncio 2 creado → ID: ${ad2.id}`);

  const ad3 = await api(`${AD_ACCOUNT}/ads`, "POST", {
    name:        "Anuncio 3 — Carrusel Antes/Después",
    adset_id:    adSets.prospeccion,
    creative:    { creative_id: creativos.creativo3 },
    status:      "PAUSED",
    tracking_specs: [{ action: ["offsite_conversion"], fb_pixel: [] }],
  });
  console.log(`  ✅ Anuncio 3 creado → ID: ${ad3.id}`);

  return [ad1.id, ad2.id, ad3.id];
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  🏗️  SS Remodelaciones — Creando Campaña Meta Ads");
  console.log("  📍 Gran Área Metropolitana, Costa Rica");
  console.log("  💰 Presupuesto: $200/mes");
  console.log("═══════════════════════════════════════════════════════");

  // Validar variables
  if (!TOKEN || !PAGE_ID || !AD_ACCOUNT) {
    console.error("❌ Faltan variables de entorno: FB_PAGE_ACCESS_TOKEN, FB_PAGE_ID, META_AD_ACCOUNT_ID");
    process.exit(1);
  }
  console.log(`\n✅ Token: ...${TOKEN.slice(-6)}`);
  console.log(`✅ Página: ${PAGE_ID}`);
  console.log(`✅ Cuenta: ${AD_ACCOUNT}`);

  try {
    // Paso 1: Subir imágenes
    const hashes = await subirImagenes();
    const hashesOk = Object.keys(hashes).length;
    console.log(`\n  📸 ${hashesOk}/10 imágenes subidas correctamente`);

    // Paso 2: Formulario
    const formId = await crearFormulario();

    // Paso 3: Campaña
    const campanaId = await crearCampana();

    // Paso 4: Ad Sets
    const adSets = await crearAdSets(campanaId);

    // Paso 5: Creativos
    const creativos = await crearCreativos(hashes, formId);

    // Paso 6: Anuncios
    const adIds = await crearAnuncios(adSets, creativos);

    console.log("\n═══════════════════════════════════════════════════════");
    console.log("  ✅ CAMPAÑA CREADA EXITOSAMENTE — ESTADO: PAUSADA");
    console.log("═══════════════════════════════════════════════════════");
    console.log(`
  📋 Formulario de leads:  ${formId}
  🚀 Campaña:              ${campanaId}
  🎯 AdSet Prospección:    ${adSets.prospeccion}
  🔄 AdSet Retargeting:    ${adSets.retargeting}
  🎨 Creativo 1 (Dolor):   ${creativos.creativo1}
  🎨 Creativo 2 (Aspir.):  ${creativos.creativo2}
  🎨 Creativo 3 (Carrusel):${creativos.creativo3}
  📣 Anuncio 1:            ${adIds[0]}
  📣 Anuncio 2:            ${adIds[1]}
  📣 Anuncio 3:            ${adIds[2]}

  👉 Para activar, ir a:
     https://business.facebook.com/adsmanager
     → Campaña "Cocinas SSR — Tu Cocina Nueva 2026"
     → Cambiar estado de PAUSADO a ACTIVO

  🤖 Sasha ya está configurada para responder cada lead
     en menos de 1 minuto por WhatsApp.
`);

  } catch (err) {
    console.error("\n❌ ERROR:", err.message);
    console.error("Revisá que FB_PAGE_ACCESS_TOKEN tenga permisos: ads_management, pages_manage_ads");
    process.exit(1);
  }
}

main();
