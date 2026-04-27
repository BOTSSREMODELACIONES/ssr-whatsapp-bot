// Base de conocimiento de SS Remodelaciones
const KNOWLEDGE = {
  empresa: {
    nombre: "SS Remodelaciones",
    razon_social: "Solo Senso S.A.",
    descripcion: "Empresa costarricense de construcción y remodelación con amplia experiencia en proyectos residenciales y comerciales.",
    zona_cobertura: "Gran Área Metropolitana (GAM) de Costa Rica y zonas cercanas",
    encargado: "Melvin Zúñiga",
    whatsapp_melvin: "+50671981370",
    // ⚠️ Reemplazar con el SINPE real de la empresa para cobros
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
      "Presupuesto detallado enviado en 24-48 horas después de la visita",
    ],
    formas_pago: ["SINPE Móvil", "Transferencia bancaria", "Efectivo en el momento de la visita"],
    pago: "Se coordina con el cliente — SINPE Móvil, transferencia o efectivo al llegar",
    dias_disponibles: "Lunes a Sábado",
    horarios: "7:00 am a 5:00 pm",
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
  ],

  proceso_obra: [
    "Visita de diagnóstico (₡25.000, se descuenta si contratás la obra).",
    "Presupuesto detallado enviado en 24-48h después de la visita.",
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
      a: "La visita de diagnóstico tiene un costo de ₡25.000, que incluye medición, asesoría y presupuesto detallado. Si luego contratás la obra, ese monto se descuenta del total. ¡Es una inversión que se recupera!"
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
};

module.exports = KNOWLEDGE;
