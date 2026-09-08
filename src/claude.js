const Anthropic = require('@anthropic-ai/sdk');
const systemPromptBase = require('../prompts/diamond');
const { getFAQPrompt } = require('./faq');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// System prompt estático (base + FAQ).
const systemPrompt = systemPromptBase + getFAQPrompt();

// Diamantito NO tiene ninguna herramienta para consultar el catálogo de
// propiedades — a propósito. Su trabajo es calificar al lead y derivarlo,
// nunca mostrarle fichas, precios ni links de propiedades puntuales (eso lo
// hace el asesor humano). Antes existía una herramienta buscar_propiedades,
// pero aunque el prompt decía "no la uses para búsquedas genéricas", la sola
// presencia de la herramienta empujaba al modelo a usarla igual. La forma
// confiable de garantizar que nunca la use es no dársela.
function extraerTexto(content) {
  const bloqueTexto = content.find((b) => b.type === 'text');
  return bloqueTexto ? bloqueTexto.text : '';
}

async function chat(historial) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ],
    messages: historial,
  });

  return extraerTexto(response.content);
}

// Schemas de extracción por flujo
const SCHEMAS = {
  propietario: `{
  "nombre": "nombre completo del propietario",
  "relacion": "propietario / familiar / representante / otro — relación con el inmueble",
  "tipo": "tipo de propiedad (casa/departamento/local/terreno/otro)",
  "sector": "sector o barrio",
  "dormitorios": "número de dormitorios",
  "superficie": "superficie aproximada",
  "ocupacion": "ocupada o desocupada",
  "operacion": "venta o arriendo",
  "precio": "precio estimado o null si necesita tasación",
  "otraInmobiliaria": "sí o no",
  "disponibilidad": "preferencia horaria (mañana/tarde) para ser contactado",
  "zona": "Manta / Portoviejo / fuera de cobertura",
  "antiguedad": "nueva / 1-5 años / 6-10 años / +10 años / no sabe",
  "prioridad": "Alta / Media / Baja según disposición",
  "observacion": "contexto relevante para el asesor, máximo 1 oración"
}`,
  asesor: `{
  "nombre": "nombre completo",
  "correo": "correo electrónico o null si no lo proporcionó",
  "edad": "edad si fue mencionada o null",
  "ciudad": "ciudad o sector donde vive",
  "comoSeEntero": "redes sociales / recomendación / anuncio / otro — cómo llegó a RE/MAX Diamond",
  "experiencia": "experiencia previa en ventas o áreas comerciales",
  "situacion": "a qué se dedica actualmente / situación laboral actual",
  "disponibilidad": "inmediata / parcial / no tiene",
  "motivacion": "motivación principal expresada",
  "otraInmobiliaria": "sí o no",
  "fondoInicial": "disponible / no mencionado / no tiene",
  "modeloComision": "abierto / entiende el modelo / rechaza",
  "cvDisponible": "sí (con referencia verificable) / sí (sin referencia) / no / null si no se preguntó",
  "descalificado": "true si fue descalificado, false si calificó"
}`,
  comprador: `{
  "nombre": "nombre completo si fue mencionado",
  "tipo": "tipo de propiedad",
  "sector": "sector o barrio en Manta o Portoviejo",
  "dormitorios": "número de dormitorios",
  "presupuesto": "presupuesto estimado",
  "codigoPropiedad": "código de la propiedad del catálogo si el lead consultó por una puntual, o null",
  "cumpleanos": "fecha de cumpleaños o null si no proporcionó"
}`,
  arrendatario: `{
  "nombre": "nombre completo si fue mencionado",
  "tiempoAlquiler": "por cuánto tiempo desea alquilar",
  "tipo": "tipo de propiedad",
  "sector": "sector o barrio en Manta o Portoviejo",
  "dormitorios": "número de dormitorios",
  "mascotas": "sí o no",
  "estacionamiento": "sí o no",
  "ascensor": "sí, no, o null si no aplica/no se preguntó",
  "presupuesto": "presupuesto mensual",
  "codigoPropiedad": "código de la propiedad del catálogo si el lead consultó por una puntual, o null",
  "cumpleanos": "fecha de cumpleaños o null si no proporcionó"
}`,
  hablar_asesor: `{
  "nombre": "nombre completo"
}`,
};

async function extraerDatos(historial, flujo) {
  const schema = SCHEMAS[flujo];
  if (!schema) return {};

  const conversacion = historial
    .map(m => `${m.role === 'user' ? 'Cliente' : 'Diamantito'}: ${m.content}`)
    .join('\n');

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system: 'Sos un extractor de datos. Analizás conversaciones de WhatsApp y extraés datos estructurados en JSON. Solo devolvés el JSON, sin texto adicional, sin markdown.',
      messages: [
        {
          role: 'user',
          content: `Extraé los datos de esta conversación y devolvelos como JSON con esta estructura exacta:\n${schema}\n\nConversación:\n${conversacion}\n\nSi un dato no fue mencionado, usá null. Solo devolvé el JSON.`,
        },
      ],
    });

    const raw = response.content[0].text.trim();
    // Limpiar posible markdown
    const jsonStr = raw.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('[claude] Error extrayendo datos:', e.message);
    return {};
  }
}

module.exports = { chat, extraerDatos };
