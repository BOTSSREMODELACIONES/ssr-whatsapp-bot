const KNOWLEDGE = {
  empresa: {
    nombre: "SS Remodelaciones",
    razon_social: "Solo Senso S.A.",
    descripcion: "Empresa costarricense de construcción y remodelación con amplia experiencia en proyectos residenciales y comerciales.",
    zona_cobertura: "Gran Área Metropolitana (GAM) de Costa Rica y zonas cercanas",
    encargado: "Melvin Zúñiga",
    whatsapp_melvin: "+50671981370",
    sinpe_numero: "+50671981370",
    sinpe_nombre: "SS Remodelaciones / Melvin Zúñiga",
  },

  visita: {
    costo: 25000,
    costo_texto: "₡25.000",
    descripcion: "Visita de diagnóstico y levantamiento del proyecto",
    duracion: "45 minutos a 1 hora aproximadamente",
    incluye: [
      "Medición y evaluación del espacio",
      "Asesoría técnica en materiales y acabados",
      "Recomendaciones de diseño",
      "Presupuesto detallado enviado en un máximo de 72 horas después de la visita (puede ser antes según la demanda del momento).",
    ],
    formas_pago: ["SINPE Móvil", "Transferencia bancaria", "Efectivo en el momento de la visita"],
    pago: "Se coordina con el cliente — SINPE Móvil, transferencia o efectivo al llegar",
    dias_disponibles: "Lunes, martes y viernes",
    horarios: "9:00 am a 5:00 pm",
    nota_descuento: "Si el cliente contrata la obra, el costo de la visita se descuenta del total del proyecto.",
  },

  servicios: [
    "Pintura interior y exterior",
    "Remodelaciones de baños",
    "Remodelaciones de cocinas",
    "Muebles de cocina y closets a medida",
    "Trabajos en melamina y carpintería",
    "Chorreado de losas y pisos de concreto",
    "Reparaciones generales de construcción",
    "Instalación de cerámica y porcelanato",
    "Trabajos en drywall y cielo raso",
    "Construcción de ampliaciones menores",
    "Instalación de puertas y ventanas",
    "Decoración con Wall Panel",
  ],

  proceso_obra: [
    "Visita de diagnóstico (₡25.000, se descuenta si contratás la obra).",
    "Presupuesto detallado enviado en un máximo de 72 horas después de la visita (puede ser antes según la demanda).",
    "Aprobación del presupuesto y firma de contrato.",
    "Coordinación de inicio de obra según disponibilidad.",
    "Pagos por avance de obra: adelanto, avances y pago final.",
    "Entrega con verificación conjunta del trabajo terminado.",
  ],

  formas_pago_obra: [
    "Transferencia bancaria",
    "SINPE Móvil",
    "Efectivo (montos menores)",
  ],

  preguntas_frecuentes: [
    {
      q: "¿Cuánto cuesta la remodelación?",
      a: "El precio varía según el tipo de trabajo, área y materiales. Para darte un número real necesitamos hacer la visita de diagnóstico (₡25.000, descontable del proyecto). Agendamos cuando vos querás 🗓️"
    },
    {
      q: "¿El presupuesto es gratis?",
      a: "La visita de diagnóstico tiene un costo de ₡25.000, que incluye medición, asesoría y presupuesto detallado. Si luego contratás la obra, ese monto se descuenta del total."
    },
    {
      q: "¿Cuándo recibo el presupuesto?",
      a: "El presupuesto detallado se envía en un máximo de 72 horas después de la visita. Dependiendo de la demanda del momento, puede llegar antes."
    },
    {
      q: "¿Cuánto tiempo tarda una remodelación?",
      a: "Depende del proyecto: pintura de una casa 1-2 semanas, remodelación de baño 2-3 semanas, cocina 3-5 semanas. En la visita te damos un cronograma exacto."
    },
    {
      q: "¿En qué zonas trabajan?",
      a: "Trabajamos en todo el Gran Área Metropolitana: San José, Heredia, Alajuela, Cartago y cantones cercanos."
    },
    {
      q: "¿Cómo son los pagos de la obra?",
      a: "Se divide por avances: adelanto al iniciar, pagos intermedios por avance de obra y pago final al terminar. Aceptamos transferencia y SINPE Móvil."
    },
    {
      q: "¿Tienen garantía?",
      a: "Sí, respaldamos la calidad de nuestros trabajos. Cualquier detalle después de la entrega lo atendemos sin costo adicional."
    },
    {
      q: "¿Tienen disponibilidad ahora?",
      a: "Para saber disponibilidad de inicio de obra hay que pasar por la visita primero. Después de eso coordinamos fechas con vos. ¿Cuándo te viene bien para la visita?"
    },
  ],

  // ─────────────────────────────────────────────────────────────────────────────
  // PRECIOS DE REFERENCIA
  // Sasha los usa para orientar al cliente con rangos aproximados.
  // SIEMPRE debe aclarar que son precios de referencia y que el presupuesto
  // exacto se entrega después de la visita técnica al sitio.
  // ─────────────────────────────────────────────────────────────────────────────
  precios_referencia: {
    disclaimer: "Estos son precios de referencia aproximados en colones costarricenses (₡). El presupuesto exacto depende del estado real del sitio, los materiales elegidos y el alcance específico del trabajo. Para una cifra precisa, lo ideal es la visita técnica.",

    pintura: {
      interior_paredes: { min: 3000, max: 6000, unidad: "m²", nota: "Incluye sellador + 2 manos de pintura premium + mano de obra. No incluye resanes." },
      exterior: { min: 4000, max: 8000, unidad: "m²", nota: "Incluye sellado básico. Andamios complejos se cotizan aparte." },
      cielo_raso: { min: 3500, max: 5500, unidad: "m²" },
      empaste_lijado: { min: 2000, max: 4000, unidad: "m²" },
      estructuras_metalicas: { min: 5000, max: 10000, unidad: "m²", nota: "Incluye anticorrosivo." },
    },

    obra_gris: {
      losa_concreto_10cm: { min: 18000, max: 28000, unidad: "m²", nota: "Incluye malla electrosoldada." },
      losa_reforzada_12_15cm: { min: 28000, max: 45000, unidad: "m²" },
      acera: { min: 12000, max: 18000, unidad: "m²", nota: "Base lastre + concreto 8 cm." },
      pared_block: { min: 18000, max: 30000, unidad: "m²" },
      repello_grueso: { min: 5000, max: 8000, unidad: "m²" },
      repello_fino: { min: 6000, max: 10000, unidad: "m²" },
      columnas: { min: 120000, max: 250000, unidad: "unidad" },
    },

    demolicion: {
      liviana: { min: 8000, max: 15000, unidad: "m²" },
      muro_concreto: { min: 20000, max: 60000, unidad: "m²" },
      retiro_escombros: { min: 80000, max: 180000, unidad: "viaje" },
    },

    electricidad: {
      punto_electrico: { min: 25000, max: 45000, unidad: "unidad" },
      punto_iluminacion: { min: 20000, max: 40000, unidad: "unidad" },
      tablero_electrico: { min: 150000, max: 400000, unidad: "unidad" },
      recableado_circuito: { min: 80000, max: 120000, unidad: "circuito" },
    },

    plomeria: {
      punto_agua_desague: { min: 30000, max: 60000, unidad: "unidad" },
      instalacion_fregadero: { min: 40000, max: 80000, unidad: "unidad" },
      instalacion_sanitario: { min: 35000, max: 70000, unidad: "unidad" },
      instalacion_ducha: { min: 40000, max: 90000, unidad: "unidad" },
    },

    carpinteria: {
      mueble_cocina_basico: { min: 180000, max: 300000, unidad: "ml" },
      cocina_premium: { min: 350000, max: 600000, unidad: "ml" },
      closet: { min: 120000, max: 250000, unidad: "ml" },
      puerta_interna_madera: { min: 90000, max: 180000, unidad: "unidad" },
    },

    pisos_revestimientos: {
      ceramica: { min: 6000, max: 10000, unidad: "m²" },
      porcelanato: { min: 10000, max: 18000, unidad: "m²" },
      azulejo_pared: { min: 7000, max: 12000, unidad: "m²" },
      nivelacion_piso: { min: 6000, max: 12000, unidad: "m²" },
    },

    ventanas_puertas: {
      ventana_aluminio: { min: 120000, max: 350000, unidad: "unidad" },
      puerta_metalica: { min: 150000, max: 350000, unidad: "unidad" },
      puerta_vidrio_temperado: { min: 180000, max: 500000, unidad: "unidad" },
    },

    mantenimiento: {
      limpieza_canoas: { min: 25000, max: 60000, unidad: "servicio" },
      lavado_presion: { min: 2000, max: 4000, unidad: "m²" },
      sellado_techo: { min: 3500, max: 7000, unidad: "m²" },
      impermeabilizacion: { min: 6000, max: 12000, unidad: "m²" },
    },

    techos: {
      cambio_laminas_zinc: { min: 12000, max: 25000, unidad: "m²" },
      estructura_metalica_liviana: { min: 25000, max: 50000, unidad: "m²" },
      cielo_raso_gypsum: { min: 10000, max: 18000, unidad: "m²" },
    },

    gypsum: {
      estructura_sola: { min: 6000, max: 9000, unidad: "m²", nota: "Solo perfilería, sin forro." },
      pared_sencilla_doble_cara: { min: 12000, max: 18000, unidad: "m²", nota: "Estructura + 1 lámina por lado. No incluye pintura ni aislamiento." },
      pared_con_aislamiento: { min: 18000, max: 28000, unidad: "m²", nota: "Incluye lana mineral o fibra de vidrio. Ideal para oficinas y habitaciones." },
      pared_doble_lamina: { min: 22000, max: 35000, unidad: "m²", nota: "2 láminas por lado, mayor resistencia acústica." },
      pared_doble_premium: { min: 28000, max: 45000, unidad: "m²", nota: "Sistema completo: doble lámina + aislamiento. Para estudios u oficinas premium." },
      extras: {
        refuerzo_interno: { min: 3000, max: 8000, unidad: "m² adicional", nota: "Para colgar muebles, TV u objetos pesados." },
        resistente_humedad: { nota: "+20% sobre precio base (gypsum RH)." },
        resistente_fuego: { nota: "+25% a +40% sobre precio base (gypsum RF)." },
        acabado_listo_pintura: { min: 2500, max: 5000, unidad: "m²" },
      },
    },

    costos_indirectos: {
      administracion: { min: 10, max: 20, unidad: "% sobre el costo directo" },
      utilidad: { min: 15, max: 35, unidad: "% sobre el costo directo" },
    },
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // ASESORÍA TÉCNICA
  // Conocimiento para orientar al cliente en diseño de interiores, arquitectura
  // y construcción. Sasha puede usar esto para dar recomendaciones generales,
  // pero NUNCA debe hacer cálculos estructurales, dimensionar elementos
  // portantes ni sustituir el criterio profesional en sitio.
  // ─────────────────────────────────────────────────────────────────────────────
  asesoria_tecnica: {

    limites: {
      puede_hacer: [
        "Orientar sobre estilos, tendencias y paletas de colores",
        "Explicar diferencias entre materiales y sistemas constructivos",
        "Describir pros y contras de cada sistema (gypsum vs block, cerámica vs porcelanato, etc.)",
        "Dar rangos de precios de referencia con su disclaimer",
        "Explicar el proceso general de una remodelación o construcción",
        "Recomendar consideraciones de diseño según el tipo de espacio",
        "Orientar sobre qué preguntas hacer al contratista en la visita",
      ],
      no_puede_hacer: [
        "Calcular cargas estructurales, vigas, columnas o cimientos",
        "Dimensionar elementos portantes (losas, paredes de carga, fundaciones)",
        "Dar criterio vinculante sobre si una pared se puede derribar o no",
        "Emitir conceptos técnicos con validez profesional (eso requiere visita e ingeniería)",
        "Garantizar que un material o sistema funcionará sin ver el sitio",
      ],
      mensaje_limite: "Para ese nivel de detalle necesitamos ver el sitio en persona. Lo que te puedo decir es orientativo — el criterio definitivo lo da nuestro equipo técnico en la visita. ¿Lo agendamos?",
    },

    // ── DISEÑO DE INTERIORES ──────────────────────────────────────────────────
    diseno_interiores: {
      nota: "Sasha puede orientar sobre estilos y tendencias para ayudar al cliente a visualizar su proyecto antes de la visita.",

      estilos: [
        {
          nombre: "Minimalista",
          descripcion: "Espacios limpios, colores neutros (blanco, gris, beige), muebles de líneas rectas y pocos elementos decorativos. El lema es 'menos es más'.",
          ideal_para: "Apartamentos pequeños, oficinas modernas, quienes buscan sensación de amplitud.",
          materiales_tipicos: "Porcelanato de gran formato, madera natural o lacada en blanco, vidrio, acero inoxidable.",
          colores: ["Blanco roto", "Gris claro", "Beige cálido", "Negro como acento"],
        },
        {
          nombre: "Industrial",
          descripcion: "Inspirado en fábricas y lofts urbanos. Combina materiales en bruto como concreto expuesto, ladrillo a la vista, acero y madera sin pulir.",
          ideal_para: "Negocios, restaurantes, espacios de trabajo creativos, residencias con techos altos.",
          materiales_tipicos: "Concreto pulido, ladrillo expuesto, tubería vista, madera rústica, metal negro.",
          colores: ["Gris cemento", "Negro", "Café tabaco", "Óxido como acento"],
        },
        {
          nombre: "Tropical moderno",
          descripcion: "Fusión entre lo contemporáneo y los elementos naturales del trópico. Muy apropiado para el clima y la cultura costarricense.",
          ideal_para: "Residencias, hoteles boutique, áreas sociales con conexión al exterior.",
          materiales_tipicos: "Madera, piedra natural, cerámica artesanal, plantas, textiles naturales.",
          colores: ["Verde selva", "Terracota", "Arena", "Blanco", "Azul agua"],
        },
        {
          nombre: "Escandinavo adaptado",
          descripcion: "Simplicidad nórdica adaptada al trópico: espacios funcionales, mucha luz, madera clara, textiles suaves. Se adapta bien omitiendo las pieles y lanas pesadas.",
          ideal_para: "Familias, habitaciones, salas de estar.",
          materiales_tipicos: "Madera clara (pino, roble), telas de algodón, cerámica blanca, plantas verdes.",
          colores: ["Blanco", "Gris suave", "Madera natural", "Verde menta como acento"],
        },
        {
          nombre: "Rústico contemporáneo",
          descripcion: "Calidez de materiales tradicionales (madera, piedra, barro) combinada con líneas modernas y buena iluminación. Popular en casas de campo y zonas rurales de CR.",
          ideal_para: "Casas de campo, zonas montañosas, fincas, residencias amplias.",
          materiales_tipicos: "Madera de guanacaste o ciprés, piedra volcánica, cerámica artesanal, hierro forjado.",
          colores: ["Café cálido", "Crema", "Verde musgo", "Terracota", "Negro"],
        },
      ],

      paletas_por_espacio: {
        sala: "Tonos neutros como base (gris, beige, blanco) con un acento de color en almohadas, cuadros o una pared. Evitá más de 3 colores en el mismo espacio.",
        cocina: "Blanco o gris en muebles superiores para dar amplitud. Madera o color en muebles inferiores para calidez. Backsplash de azulejo como elemento de diseño.",
        bano: "Colores claros para sensación de limpieza y amplitud. Azulejo hasta el techo en la ducha. Un tono oscuro en una pared puede dar elegancia en baños grandes.",
        habitacion: "Tonos suaves y cálidos favorecen el descanso: beige, lavanda suave, verde salvia, gris azulado. Evitá rojos o naranjas intensos.",
        oficina: "Colores que estimulen la concentración: azul claro, verde suave, blanco. Un mueble oscuro o una pared de color crea profundidad sin recargar.",
      },

      tendencias_cr_2025: [
        "Porcelanato imitación madera o concreto en pisos — alta demanda en residencias nuevas",
        "Cocinas con isla central cuando el espacio lo permite",
        "Baños con ducha italiana (sin bordes, piso continuo) y grifería negra o dorada",
        "Wall Panel decorativo en sala o habitación principal como punto focal",
        "Cielos rasos con iluminación LED integrada (canaletas o cornisas)",
        "Tonos tierra y verdes naturales en pintura de interiores",
        "Ventanas de piso a techo donde la estructura lo permite, para aprovechar luz natural",
        "Muebles de cocina con puertas sin jaladores (push-to-open) para look minimalista",
      ],

      consejos_espacios_pequenos: [
        "Usar colores claros en paredes y pisos para ampliar visualmente el espacio",
        "Espejos estratégicos en sala o comedor duplican la sensación de profundidad",
        "Muebles multifuncionales: camas con cajones, sofás cama, mesas plegables",
        "Minimizar divisiones físicas — preguntar al equipo técnico si una pared es portante antes de derribarla",
        "Iluminación por zonas (no solo una lámpara central) hace el espacio más dinámico",
        "Pisos continuos sin cortes entre ambientes aumentan la sensación de amplitud",
      ],
    },

    // ── ARQUITECTURA BÁSICA ───────────────────────────────────────────────────
    arquitectura: {
      nota: "Información general para que el cliente entienda los tipos de construcción y pueda conversar mejor con el equipo técnico.",

      tipos_construccion_cr: [
        {
          tipo: "Mampostería (block y concreto)",
          descripcion: "El sistema más común en Costa Rica. Paredes de block de concreto con columnas y vigas de concreto reforzado. Alta durabilidad y resistencia sísmica.",
          ventajas: ["Muy durable (50+ años)", "Excelente resistencia sísmica y al fuego", "Buen aislamiento térmico y acústico", "Bajo mantenimiento a largo plazo"],
          desventajas: ["Proceso más lento", "Requiere curado del concreto", "Difícil de modificar una vez construido"],
          usos_tipicos: "Casas, edificios, muros perimetrales, fundaciones",
        },
        {
          tipo: "Sistema liviano (gypsum / drywall)",
          descripcion: "Estructura metálica ligera cubierta con láminas de yeso. Ideal para divisiones internas, cielos rasos, remodelaciones y acabados.",
          ventajas: ["Instalación rápida", "Fácil de modificar o demoler", "Permite pasar instalaciones (electricidad, datos) dentro", "Acabado limpio y uniforme"],
          desventajas: ["Menor resistencia a golpes fuertes vs block", "Requiere refuerzo interno para colgar objetos pesados", "Sensible a la humedad si no se usa tipo RH"],
          usos_tipicos: "Divisiones de oficinas, cielos rasos, cuartos de hotel, acabados interiores",
        },
        {
          tipo: "Construcción mixta",
          descripcion: "Combina estructura de mampostería en elementos portantes con gypsum en divisiones internas. Muy común en remodelaciones y ampliaciones.",
          ventajas: ["Flexibilidad de diseño", "Velocidad en acabados interiores", "Economía en divisiones no estructurales"],
          usos_tipicos: "Remodelaciones de casas existentes, oficinas, locales comerciales",
        },
        {
          tipo: "Estructura metálica",
          descripcion: "Estructura principal de acero o hierro. Común en construcciones industriales, bodegas, ampliaciones de techo y entrepisos.",
          ventajas: ["Muy rápida de armar", "Permite grandes luces sin columnas intermedias", "Liviana sobre estructuras existentes"],
          desventajas: ["Requiere mantenimiento anticorrosivo", "Transmite calor (requiere aislamiento en techos)", "Costo de acero variable"],
          usos_tipicos: "Techos, bodegas, cubiertas, entrepisos, ampliaciones comerciales",
        },
      ],

      elementos_constructivos: {
        fundacion: "Base que transfiere las cargas del edificio al suelo. En CR las más comunes son zapatas aisladas, vigas de amarre y losas de fundación. Su diseño depende del tipo de suelo — requiere criterio de ingeniero.",
        columnas: "Elementos verticales que transmiten cargas de losa a fundación. En mampostería son de concreto reforzado. Su ubicación y dimensión la define el ingeniero estructural.",
        vigas: "Elementos horizontales que reciben las cargas del piso o techo y las transfieren a las columnas. No se deben cortar ni debilitar sin criterio técnico.",
        losa: "Placa horizontal de concreto reforzado que forma el piso o techo. Puede ser maciza o con nervios. El espesor mínimo típico en CR es 10 cm para losas de entrepiso.",
        paredes_portantes: "Paredes que forman parte de la estructura y no se pueden derribar sin análisis. En casas de block antiguas, casi todas las paredes externas son portantes.",
        paredes_divisorias: "Paredes que solo dividen espacios y no cargan peso estructural. Generalmente se pueden modificar, pero siempre hay que confirmarlo con el técnico.",
        techo: "El sistema más común en CR es estructura metálica con láminas de zinc o aluzinc. Los techos de teja y los de losa son menos frecuentes pero existen.",
      },

      consideraciones_clima_cr: [
        "Costa Rica tiene clima tropical húmedo — la ventilación natural es fundamental en el diseño",
        "La orientación norte-sur de ventanas maximiza luz sin calor directo en zonas cálidas",
        "En zonas de mucha lluvia (Pacífico, Caribe) los aleros amplios protegen paredes y ventanas",
        "La humedad acelera el deterioro de maderas sin tratamiento, pinturas de baja calidad y metales sin anticorrosivo",
        "En zonas frías (Heredia alta, Cartago, San Ramón) el aislamiento térmico en losas y paredes marca diferencia en confort",
        "El sellado de techos y la impermeabilización son inversiones de alto retorno en CR dado el volumen de lluvia anual",
      ],

      tramites_permisos_cr: {
        nota: "Información orientativa. Para trámites específicos se recomienda consultar directamente con el CFIA o la municipalidad correspondiente.",
        visado_cfia: "Proyectos nuevos o ampliaciones significativas requieren planos visados por el Colegio Federado de Ingenieros y Arquitectos (CFIA). Sasha no gestiona permisos.",
        permiso_municipal: "Toda construcción o remodelación mayor requiere permiso de construcción en la municipalidad del cantón.",
        obras_menores: "Remodelaciones internas (pintura, pisos, muebles, cielos rasos) generalmente no requieren permiso, pero conviene confirmarlo con la municipalidad.",
        profesional_responsable: "Obras de cierta envergadura requieren un profesional responsable (ingeniero o arquitecto) inscrito en el CFIA.",
      },
    },

    // ── INGENIERÍA CIVIL — SOLO ORIENTATIVA ──────────────────────────────────
    ingenieria_orientativa: {
      nota: "Sasha puede explicar qué es cada elemento y para qué sirve, pero NUNCA debe dimensionar, calcular ni opinar sobre si un elemento específico es adecuado sin verlo.",

      conceptos_comunes: {
        impermeabilizacion: {
          descripcion: "Proceso de aplicar membranas o productos sellantes para evitar filtraciones de agua en losas, techos, muros y baños.",
          cuando_es_necesaria: "Cubiertas expuestas, terrazas transitables, baños, sótanos, paredes en contacto con suelo húmedo.",
          tipos_comunes: ["Membrana asfáltica (lámina)", "Impermeabilizante líquido (elastomérico)", "Cristalización (para concreto)", "Pintura impermeabilizante para techos de zinc"],
          vida_util_aproximada: "De 5 a 15 años según el producto y la aplicación. Requiere mantenimiento periódico.",
        },
        repello: {
          descripcion: "Revestimiento de mortero aplicado sobre block o concreto para lograr una superficie uniforme antes de la pintura.",
          tipos: {
            grueso: "Primera capa, más rugosa, nivela imperfecciones grandes. Generalmente 1–2 cm de espesor.",
            fino: "Segunda capa, más suave, prepara la superficie para pintura o empaste.",
            afinado: "Acabado tipo concreto expuesto o liso, sin necesidad de pintura.",
          },
        },
        contrapiso: {
          descripcion: "Losa delgada de concreto (generalmente 5–8 cm) que se chorrea sobre el suelo nivelado para dar base a cerámica, porcelanato o piso de madera.",
          cuando_es_necesario: "Cuando hay desnivel en el piso existente, cuando se cambia el sistema de piso, o en construcción nueva.",
        },
        viga_corona: {
          descripcion: "Viga horizontal de concreto reforzado que corre en la parte superior de las paredes de block, amarra la estructura y recibe la carga del techo.",
          nota: "No se debe cortar ni debilitar. Su presencia es fundamental para la estabilidad sísmica del edificio.",
        },
        acero_refuerzo: {
          descripcion: "Varillas de hierro (hierro corrugado) que se colocan dentro del concreto para darle resistencia a la tensión. El concreto solo resiste bien la compresión.",
          varillas_comunes_cr: ["#3 (3/8\")", "#4 (1/2\")", "#5 (5/8\")", "#6 (3/4\")"],
          nota: "La cantidad y disposición de acero en losas, columnas y vigas la define el ingeniero estructural. Sasha no puede dar esos datos.",
        },
        resistencia_concreto: {
          descripcion: "Se mide en kg/cm² o en f'c (MPa). En Costa Rica el mínimo para elementos estructurales residenciales según el CSCR es 210 kg/cm² (f'c = 21 MPa).",
          uso_comun: "210 kg/cm² para losas y columnas residenciales. 280 kg/cm² para obras con mayor exigencia.",
          nota: "Sasha puede mencionar el estándar, pero el diseño de mezcla lo define el profesional responsable.",
        },
      },

      senales_de_alerta: {
        descripcion: "Señales que el cliente puede identificar y que justifican una inspección técnica urgente.",
        lista: [
          "Grietas diagonales en esquinas de puertas o ventanas (pueden indicar asentamiento diferencial)",
          "Grietas horizontales en paredes de block (pueden indicar falla en viga o sobrecarga)",
          "Humedad persistente en paredes o techo aunque no llueva (filtración activa)",
          "Abombamiento o desprendimiento de repello (indica problemas de humedad detrás de la pared)",
          "Pisos que suenan a hueco o se mueven al caminar (subsuelo comprometido o contrapiso despegado)",
          "Puertas o ventanas que ya no cierran bien sin razón aparente (puede indicar movimiento estructural)",
          "Eflorescencias blancas en paredes (sales minerales arrastradas por humedad)",
          "Óxido que sale de paredes de concreto (corrosión del acero de refuerzo, señal seria)",
        ],
        mensaje: "Si el cliente reporta alguna de estas señales, Sasha debe darle prioridad alta y recomendar la visita técnica lo antes posible.",
      },
    },
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // EMERGENCIAS Y URGENCIAS
  // ─────────────────────────────────────────────────────────────────────────────
  emergencias: {
    palabras_clave: [
      "emergencia", "urgente", "urgencia", "se está lloviendo", "se me está lloviendo",
      "tubería rota", "tubo roto", "inundación", "se inundó", "se cayó", "derrumbe",
      "grieta nueva", "grieta grande", "sin agua", "cortocircuito", "corto circuito",
      "se fue la luz", "humo", "incendio", "hundimiento", "losa cayó",
    ],
    instrucciones_contencion: {
      tuberia_inundacion: "Cierre la llave de paso principal mientras llegamos. Generalmente está en la entrada del terreno o bajo el fregadero.",
      electrico: "Baje el breaker de ese circuito en el tablero eléctrico. Si no sabe cuál es, baje el breaker general.",
      filtracion_techo: "Coloque recipientes bajo las goteras y cubra muebles y electrodomésticos con plástico por ahora.",
      grieta_estructura: "No use esa área hasta que la revisemos. Evite cargas adicionales (muebles pesados, personas).",
      general: "Aleje a las personas del área afectada y espere a nuestro equipo.",
    },
    mensaje_respuesta: "Entiendo, tranquilo/a — le vamos a ayudar. Le contactará nuestro equipo en los próximos minutos.",
    tiempo_respuesta: "Melvin se comunica en un máximo de 30 minutos en horario laboral.",
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // MANEJO DE OBJECIONES
  // ─────────────────────────────────────────────────────────────────────────────
  objeciones: {
    nota: "Sasha usa estas orientaciones cuando el cliente expresa resistencia. Siempre con empatía, nunca con presión.",
    respuestas: [
      {
        trigger: "Es muy caro / está muy alto / no tengo presupuesto",
        estrategia: "Calificar presupuesto real. Posicionar valor. Nunca bajar precio sin ver el proyecto.",
        respuesta_guia: "Entiendo perfectamente. ¿Me permite preguntarle qué rango de inversión tiene en mente? Así le orientamos hacia las opciones que mejor le funcionen — hay soluciones para distintos presupuestos.",
      },
      {
        trigger: "Lo pienso / le aviso / déjeme consultarlo",
        estrategia: "Crear ventana de acción sin presionar. Usar escasez real de agenda.",
        respuesta_guia: "Claro, con toda confianza. Solo le cuento que los espacios de visita esta semana están limitados — si quiere lo reservamos hoy y si cambia de opinión lo cancelamos sin ningún problema.",
      },
      {
        trigger: "Tengo otro presupuesto más barato / el vecino me lo hace menos",
        estrategia: "Nunca atacar a la competencia. Preguntar qué incluye. Posicionar diferenciadores reales.",
        respuesta_guia: "Es normal comparar y está bien hacerlo. ¿Qué incluye el otro presupuesto? Nosotros trabajamos con materiales de primera, garantía del trabajo y un equipo con experiencia comprobada — eso marca diferencia en el resultado final.",
      },
      {
        trigger: "Estoy cotizando / primero veo más opciones",
        estrategia: "Posicionar la visita como herramienta de información neutral, no como compromiso.",
        respuesta_guia: "Perfecto, es lo más sensato. Mientras cotiza, ¿le agendo la visita? Le va a dar información real del proyecto — la use con quien decida contratar. No hay compromiso.",
      },
      {
        trigger: "No confío / cómo sé que son serios / quiero referencias",
        estrategia: "Prueba social concreta. Fotos de proyectos. Contacto humano disponible.",
        respuesta_guia: "Completamente válido. ¿Le comparto fotos de proyectos similares que hemos hecho? Y si prefiere hablar directamente con Melvin, nuestro encargado, con gusto lo conecto.",
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // CALIFICACIÓN DE PRESUPUESTO
  // ─────────────────────────────────────────────────────────────────────────────
  calificacion_presupuesto: {
    nota: "Sasha pregunta por el rango de presupuesto UNA sola vez, al inicio cuando el cliente describe el proyecto. Si no quiere darlo, se continúa sin insistir.",
    pregunta: "Para orientarle mejor: ¿tiene en mente un rango de inversión aproximado? No necesita ser exacto.",
    respuesta_bajo: "Para ese rango podemos enfocarnos en las prioridades del proyecto — hay soluciones inteligentes que maximizan el resultado. En la visita lo definimos.",
    respuesta_alto: "Con ese presupuesto tenemos buena amplitud para trabajar con materiales de primera y un acabado de alto nivel. En la visita lo detallamos.",
    respuesta_no_da: "Sin problema, en la visita lo evaluamos con calma.",
    rangos_internos: {
      nota: "Solo para contexto de Sasha. NO cotizar con estos rangos, son orientativos.",
      pintura_casa_completa: { min: 800000, max: 2500000, referencia: "casa 100-150 m²" },
      bano_completo: { min: 1500000, max: 5000000, referencia: "baño 4-8 m²" },
      cocina_completa: { min: 2000000, max: 8000000, referencia: "cocina 6-12 m²" },
      pisos_ceramica: { min: 500000, max: 2000000, referencia: "área 30-50 m²" },
      ampliacion_habitacion: { min: 5000000, max: 15000000, referencia: "cuarto 12-20 m²" },
      cielo_raso_gypsum: { min: 400000, max: 1500000, referencia: "área 30-50 m²" },
      muebles_cocina: { min: 1500000, max: 6000000, referencia: "3-5 metros lineales" },
      impermeabilizacion_techo: { min: 300000, max: 1200000, referencia: "techo 60-100 m²" },
    },
  },
};

module.exports = KNOWLEDGE;
