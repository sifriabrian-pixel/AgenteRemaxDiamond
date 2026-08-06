// FAQ — respuestas exactas que Diamantito debe usar.
// PENDIENTE: este FAQ fue adaptado del de RE/MAX Impacta. Debe ser revisado y aprobado
// por RE/MAX Diamond antes de producción — varios datos (horario, comisiones, zonas) son placeholders.

const FAQ = [
  // SOBRE LA OPERACIÓN
  {
    pregunta: '¿Cuáles son los costos de corretaje?',
    sinonimos: ['costo', 'cobran', 'honorarios', 'comisión', 'precio del servicio', 'cuánto cobran'],
    respuesta: `Excelente pregunta. Los costos de corretaje varían según el tipo de propiedad, la operación y la estrategia que necesitemos aplicar. Lo más importante es que un asesor revise su caso específico y le explique las condiciones de forma clara, sin sorpresas. ¿Le gustaría que le derive con alguien para que le brinde una orientación completa?`,
  },
  {
    pregunta: '¿Cómo sé cuánto vale mi propiedad?',
    sinonimos: ['valor', 'valorización', 'tasación', 'precio de mi propiedad', 'cuánto vale', 'a cuánto vendo'],
    respuesta: `El valor de una propiedad depende de varios factores: ubicación, metraje, estado, características especiales, y cómo está el mercado en su zona. La mejor forma es que un asesor haga una evaluación profesional analizando propiedades similares en su sector. Así podemos darle una valorización realista. ¿Quiere que lo conecte con un asesor para que vea su propiedad?`,
  },
  {
    pregunta: '¿Cuánto tiempo toma vender una propiedad?',
    sinonimos: ['tiempo para vender', 'cuánto tarda', 'plazo de venta', 'demora en vender'],
    respuesta: `El tiempo depende de varios factores: el tipo de propiedad, el precio, dónde esté ubicada, y cómo está la demanda en esa zona. Con una buena estrategia comercial podemos acelerar los resultados. La mejor forma es que un asesor haga una evaluación profesional analizando propiedades similares en su sector. Así podemos darle una estimación realista. ¿Quiere que lo conecte con un asesor para que vea su propiedad?`,
  },
  {
    pregunta: '¿Me garantizan que se vende?',
    sinonimos: ['garantía de venta', 'garantizan', 'seguro que se vende', 'van a vender'],
    respuesta: `Nosotros no podemos garantizar una venta, porque el mercado tiene sus propias reglas. Lo que sí hacemos es aplicar una estrategia profesional para maximizar sus oportunidades: buena presentación, marketing efectivo, y valorización correcta. El éxito depende del precio, las condiciones de la propiedad, y cómo esté la demanda. Con nuestro acompañamiento aumentamos significativamente las chances. ¿Quiere que lo conecte con un asesor para que vea su propiedad?`,
  },

  // SOBRE SER ASESOR
  {
    pregunta: '¿Cuánto gana un asesor en RE/MAX?',
    sinonimos: ['cuánto gana', 'sueldo de asesor', 'ingresos como asesor', 'ganancias', 'cuánto se gana'],
    respuesta: `Los ingresos en RE/MAX varían mucho según cuánto venda, su comisión, y el nivel de gestión que realice. Lo importante es que NO hay techo — puede ganar tanto como su esfuerzo y constancia le permitan. Los asesores que trabajan con disciplina comercial y aprovechan el acompañamiento de la oficina logran resultados realmente significativos. Es un modelo donde cuanto más trabaja, más gana. ¿Le gustaría conocer los requisitos y dar los primeros pasos en el proceso de selección?`,
  },
  {
    pregunta: '¿Debo dedicarme a tiempo completo?',
    sinonimos: ['tiempo completo', 'dedicación', 'part time', 'medio tiempo', 'horas de trabajo'],
    respuesta: `Para que pueda iniciar correctamente, necesitamos que tenga disponibilidad y compromiso, especialmente durante la formación y los primeros meses. Es un negocio que requiere dedicación, pero una vez que construye su base de clientes, el modelo funciona muy bien. Primero hablamos de sus posibilidades para ver si podemos hacer que esto funcione para usted. ¿Le gustaría conocer los requisitos y dar los primeros pasos en el proceso de selección?`,
  },
  {
    pregunta: '¿Cuánto cuesta ser asesor?',
    sinonimos: ['costo de ser asesor', 'inversión', 'cuánto pago', 'hay que pagar', 'pago de entrada'],
    respuesta: `Hay una inversión inicial que varía según el proceso de incorporación, la formación y las herramientas que ofrecemos. Lo importante es que esto queda claro desde el principio. Primero revisamos su perfil, sus posibilidades, y luego le explicamos todo con transparencia antes de que tome cualquier decisión. Sin sorpresas. ¿Le gustaría conocer los requisitos y dar los primeros pasos en el proceso de selección?`,
  },

  // CONTACTO Y PROCESO
  {
    pregunta: '¿A qué hora atienden?',
    sinonimos: ['horario', 'hora de atención', 'cuándo atienden', 'están disponibles', 'horario de oficina'],
    // Horario confirmado por Diamond (2026): lun-vie 08:30-17:30
    respuesta: `Nuestro horario es de lunes a viernes, de 8:30 a.m. a 5:30 p.m. Si me escribe fuera de ese horario, tomo sus datos sin problema y un asesor lo contacta apenas sea posible. No pierde su consulta — solo arreglamos para atenderlo en el horario que corresponda. ¿Hay algo específico en lo que pueda ayudarle ahora?`,
  },

  // COBERTURA GEOGRÁFICA
  {
    pregunta: '¿En qué zonas atienden?',
    sinonimos: ['zonas', 'sectores', 'cobertura', 'dónde trabajan', 'en qué lugares'],
    // Cobertura confirmada por Diamond (2026): Manta y Portoviejo, Ecuador
    respuesta: `Nuestro equipo atiende Manta y Portoviejo, con oficina en cada ciudad. Donde sea que esté su propiedad, tenemos asesores para atenderlo. Si en algún caso la propiedad está fuera de nuestra zona de cobertura, se lo comentamos con claridad. ¿Hay algo específico en lo que pueda ayudarle ahora?`,
  },

  // HERRAMIENTAS PARA ASESORES
  {
    pregunta: '¿Qué herramientas recibo como asesor?',
    sinonimos: ['herramientas', 'qué incluye', 'qué ofrecen', 'recursos para asesores', 'apoyo de remax'],
    respuesta: `Como asesor recibe mucho más que solo una plataforma. Tiene formación continua, una metodología probada, herramientas tecnológicas para gestionar sus clientes, recursos de marketing, y lo más importante: acompañamiento real del equipo. Según la etapa en la que esté, el apoyo varía — pero siempre está ahí. Es un ecosistema completo diseñado para que tenga éxito. ¿Le gustaría conocer los requisitos y dar los primeros pasos en el proceso de selección?`,
  },
];

function getFAQPrompt() {
  const items = FAQ.map((item, i) =>
    `${i + 1}. Pregunta: "${item.pregunta}"\n   Palabras clave: ${item.sinonimos.join(', ')}\n   Respuesta exacta: "${item.respuesta}"`
  ).join('\n\n');

  return `
---

FAQ APROBADO — RESPUESTAS EXACTAS

Cuando alguien haga una pregunta que coincida con alguna de las siguientes (por palabras clave o intención), respondé EXACTAMENTE con la respuesta indicada. No la cambies ni la improvises.

Si la pregunta NO está en este FAQ → respondé amablemente que la derive con un asesor y emití [HANDOFF_GENERAL].

${items}
`;
}

module.exports = { FAQ, getFAQPrompt };
