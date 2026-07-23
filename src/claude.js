const Anthropic = require('@anthropic-ai/sdk');
const systemPromptBase = require('../prompts/diamond');
const { getFAQPrompt } = require('./faq');
const propiedades = require('./propiedades');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// System prompt estático (base + FAQ). El catálogo de propiedades (800+ activas,
// ~30.000 tokens si se metiera entero) NO se inyecta acá — Diamantito lo consulta
// bajo demanda con la herramienta buscar_propiedades, así solo gasta tokens en
// los resultados relevantes de cada búsqueda puntual.
const systemPrompt = systemPromptBase + getFAQPrompt();

const TOOLS = [
  {
    name: 'buscar_propiedades',
    description:
      'Busca en el catálogo de propiedades ACTIVAS de RE/MAX Diamond. Usar siempre que un lead pregunte por una propiedad puntual (por código) o quiera ver opciones que coincidan con lo que busca. Nunca inventar propiedades ni datos — solo usar lo que devuelve esta herramienta. Devuelve como máximo 10 resultados; si "total" es mayor a la cantidad de resultados, pedirle al lead más detalle para acotar la búsqueda (sector, tipo, presupuesto).',
    input_schema: {
      type: 'object',
      properties: {
        codigo: { type: 'string', description: 'Código exacto de una propiedad puntual, ej. EC.89.34.4.1' },
        tipo: { type: 'string', description: 'Tipo de propiedad, ej. Casa, Departamento, Terreno, Local comercial' },
        operacion: { type: 'string', enum: ['Venta', 'Alquiler'] },
        sector: { type: 'string', description: 'Sector o barrio (búsqueda parcial, ej. "Manta", "Portoviejo")' },
        dormitorios_min: { type: 'integer', description: 'Cantidad mínima de dormitorios' },
        precio_min: { type: 'number' },
        precio_max: { type: 'number' },
      },
    },
  },
];

async function ejecutarHerramienta(nombre, input) {
  if (nombre === 'buscar_propiedades') {
    try {
      const { total, resultados } = await propiedades.buscarPropiedades(input);
      return JSON.stringify({ total, resultados });
    } catch (e) {
      console.error('[claude] Error en buscar_propiedades:', e.message);
      return JSON.stringify({ error: 'No se pudo consultar el catálogo en este momento.' });
    }
  }
  return JSON.stringify({ error: `Herramienta desconocida: ${nombre}` });
}

function extraerTexto(content) {
  const bloqueTexto = content.find((b) => b.type === 'text');
  return bloqueTexto ? bloqueTexto.text : '';
}

const MAX_ITERACIONES_TOOL_USE = 4;

async function chat(historial) {
  const mensajes = [...historial];

  for (let i = 0; i < MAX_ITERACIONES_TOOL_USE; i++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      ],
      tools: TOOLS,
      messages: mensajes,
    });

    if (response.stop_reason !== 'tool_use') {
      return extraerTexto(response.content);
    }

    mensajes.push({ role: 'assistant', content: response.content });

    const llamadas = response.content.filter((b) => b.type === 'tool_use');
    const resultados = await Promise.all(
      llamadas.map(async (llamada) => ({
        type: 'tool_result',
        tool_use_id: llamada.id,
        content: await ejecutarHerramienta(llamada.name, llamada.input),
      })),
    );
    mensajes.push({ role: 'user', content: resultados });
  }

  console.error('[claude] Se alcanzó el máximo de iteraciones de tool_use sin respuesta final');
  return 'Hubo un inconveniente técnico buscando esa información. Un asesor la va a confirmar en breve.';
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
  "motivo": "motivo de venta o arriendo",
  "precio": "precio estimado o null si necesita tasación",
  "urgencia": "plazo o urgencia",
  "otraInmobiliaria": "sí o no",
  "disponibilidad": "día y preferencia horaria (mañana/tarde) para ser contactado",
  "cumpleanos": "fecha de cumpleaños o null si no proporcionó",
  "zona": "Manta / alrededores / fuera de cobertura",
  "antiguedad": "nueva / 1-5 años / 6-10 años / +10 años / no sabe",
  "prioridad": "Alta / Media / Baja según urgencia y disposición",
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
  "sector": "sector o barrio en Manta",
  "dormitorios": "número de dormitorios",
  "presupuesto": "presupuesto estimado",
  "codigoPropiedad": "código de la propiedad del catálogo si el lead consultó por una puntual, o null",
  "cumpleanos": "fecha de cumpleaños o null si no proporcionó"
}`,
  arrendatario: `{
  "nombre": "nombre completo si fue mencionado",
  "tipo": "tipo de propiedad",
  "sector": "sector o barrio en Manta",
  "dormitorios": "número de dormitorios",
  "presupuesto": "presupuesto mensual",
  "codigoPropiedad": "código de la propiedad del catálogo si el lead consultó por una puntual, o null",
  "cumpleanos": "fecha de cumpleaños o null si no proporcionó"
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
