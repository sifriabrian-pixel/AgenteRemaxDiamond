const Anthropic = require('@anthropic-ai/sdk');
const systemPromptBase = require('../prompts/diamond');
const { getFAQPrompt } = require('./faq');
const { getPautadas } = require('./pautadas');
const { textoFicha } = require('./ficha');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// El precio de las pautadas solo se le da al lead si la oficina lo aprobó
// (PAUTADAS_MOSTRAR_PRECIO=1). Si no, ni siquiera se le pasa a Claude.
const mostrarPrecio = () => process.env.PAUTADAS_MOSTRAR_PRECIO === '1';

// Datos de la publicación (scripts/actualizar-pautadas.js), en texto.
function datosFicha(f) {
  if (!f) return '   Datos: no disponibles — cualquier detalle se lo responde el asesor.';
  const lineas = [];
  if (mostrarPrecio() && f.precio) lineas.push(`Precio: ${f.moneda} ${Number(f.precio).toLocaleString('es-EC')}`);
  if (f.direccion) lineas.push(`Ubicación: ${f.direccion}`);
  // "pisos de la propiedad" es ambiguo en las publicaciones (pisos del edificio o de la unidad): no se pasa.
  for (const [k, v] of Object.entries(f.datos || {})) if (!/^pisos/.test(k)) lineas.push(`${k.charAt(0).toUpperCase() + k.slice(1)}: ${v}`);
  if (f.descripcion) lineas.push(`Descripción: ${f.descripcion}`);
  return lineas.map((l) => `   ${l}`).join('\n');
}

// Lista de PROPIEDADES PAUTADAS: sale de data/propiedades_pautadas.json, así
// el prompt y la derivación al asesor nunca quedan desfasados.
function listaPautadas() {
  return getPautadas().map((p, i) => {
    const ficha = textoFicha(p, { conPrecio: mostrarPrecio() });
    return [
      `${i + 1}. [${p.id}] ${p.tipo} en ${String(p.operacion || 'Venta').toUpperCase()} — ${p.descripcion} — asesor: ${p.asesorNombre}`,
      `   Anuncio: "${p.anuncio || p.descripcion}"`,
      `   Link: ${p.url}`,
      datosFicha(p.ficha),
      ficha ? `   FICHA PARA ENVIAR (cópiela tal cual, sin cambiar nada):\n<<<\n${ficha}\n>>>` : '   FICHA PARA ENVIAR: no hay — en el PASO 1 mande el link.',
    ].join('\n');
  }).join('\n\n');
}

const reglaPrecio = () => (mostrarPrecio()
  ? 'Si pregunta el precio, recuérdeselo con el dato de la ficha (ej. "Son USD 1.300 mensuales, más USD 95 de alícuota"). Si pregunta por negociación o descuentos, eso lo conversa con [asesor].'
  : 'Si pregunta el precio, dígale que lo ve en la publicación ([url]) y que cualquier detalle de precio o negociación se lo confirma [asesor]. No escriba ningún monto.');

// System prompt estático (base + pautadas + FAQ).
const systemPrompt = systemPromptBase
  .replace('{{PAUTADAS}}', listaPautadas())
  .replace('{{REGLA_PRECIO}}', reglaPrecio()) + getFAQPrompt();

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

// contextoDinamico: texto que cambia en cada mensaje (fecha/hora real,
// opciones de agendamiento) — va en un bloque de system APARTE, sin cache,
// porque el bloque de arriba sí se cachea y no puede variar entre llamadas.
async function chat(historial, contextoDinamico) {
  const system = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
  ];
  if (contextoDinamico) {
    system.push({ type: 'text', text: contextoDinamico });
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system,
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
  "zona": "Manta / Portoviejo / otra ciudad de Manabí / fuera de cobertura (Puerto Cayo, Puerto López o fuera de Manabí)",
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
  "sector": "ciudad o sector (Manabí)",
  "dormitorios": "número de dormitorios",
  "presupuesto": "presupuesto estimado",
  "codigoPropiedad": "código de la propiedad del catálogo si el lead consultó por una puntual, o null"
}`,
  arrendatario: `{
  "nombre": "nombre completo si fue mencionado",
  "tiempoAlquiler": "por cuánto tiempo desea alquilar",
  "tipo": "tipo de propiedad",
  "sector": "ciudad o sector (Manabí)",
  "dormitorios": "número de dormitorios",
  "mascotas": "sí o no",
  "estacionamiento": "sí o no",
  "ascensor": "sí, no, o null si no aplica/no se preguntó",
  "presupuesto": "presupuesto mensual",
  "codigoPropiedad": "código de la propiedad del catálogo si el lead consultó por una puntual, o null"
}`,
  hablar_asesor: `{
  "nombre": "nombre completo"
}`,
  fuera_cobertura: `{
  "nombre": "nombre completo, o null si no lo dio",
  "tipo": "tipo de propiedad que busca o quiere vender (casa/departamento/terreno/local/otro), o null",
  "sector": "ciudad o zona que mencionó (la que quedó fuera de cobertura), o null",
  "operacion": "venta / arriendo / compra / alquiler según lo que quiere hacer, o null"
}`,
  pautada: `{
  "nombre": "nombre completo, o null si no lo dio",
  "interes": "vivir / inversión / uso propio, según lo que haya respondido, o null si no se preguntó todavía",
  "duda": "pregunta o duda puntual que planteó sobre la propiedad, o null si no hizo ninguna"
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
