const crypto = require('crypto');

const GRAPH_VERSION = 'v21.0';

function phoneNumberId() {
  return process.env.WHATSAPP_PHONE_NUMBER_ID;
}

function token() {
  return process.env.WHATSAPP_TOKEN;
}

// Bug conocido de Meta: para Argentina, el webhook entrega el número del
// remitente CON un "9" extra después del código de país (ej. 549341...),
// pero para RESPONDERLE por la API hay que mandarlo SIN ese "9" (54341...).
// Si no se hace esta conversión, Meta rechaza el envío con "recipient phone
// number not in allowed list" aunque el número esté verificado.
// México tiene una particularidad parecida (un "1" de más en vez de "9").
function formatDestino(numero) {
  if (/^549\d{10}$/.test(numero)) return '54' + numero.slice(3); // Argentina
  if (/^521\d{10}$/.test(numero)) return '52' + numero.slice(3); // México
  return numero;
}

async function sendMessage(to, text) {
  const destino = formatDestino(to);
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId()}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: destino,
      type: 'text',
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`WhatsApp API ${res.status}: ${errBody}`);
  }

  const json = await res.json();
  const msgId = json?.messages?.[0]?.id;
  const msgStatus = json?.messages?.[0]?.message_status;
  console.log(`[wa] sendMessage → to:${to} id:${msgId || '-'} status:${msgStatus || 'accepted'}`);
  if (msgStatus === 'failed') {
    throw new Error(`WhatsApp mensaje rechazado internamente: ${JSON.stringify(json)}`);
  }
  return json;
}

// Envía un mensaje de plantilla aprobada (obligatorio para mensajes que la
// empresa inicia fuera de la ventana de servicio de 24hs, ej. follow-ups).
// parametros es un objeto { nombreVariable: valor }, ej. { nombre: 'Juan', sector: 'Cumbayá' }
async function sendTemplate(to, nombrePlantilla, idioma, parametros = {}) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId()}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: formatDestino(to),
    type: 'template',
    template: {
      name: nombrePlantilla,
      language: { code: idioma },
    },
  };

  const nombresVariables = Object.keys(parametros);
  if (nombresVariables.length > 0) {
    body.template.components = [
      {
        type: 'body',
        // Variables posicionales ({{1}}, {{2}}…) no usan parameter_name
        parameters: nombresVariables.map((nombreVar) => {
          const param = { type: 'text', text: parametros[nombreVar] };
          if (!/^\d+$/.test(nombreVar)) param.parameter_name = nombreVar;
          return param;
        }),
      },
    ];
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`WhatsApp API ${res.status}: ${errBody}`);
  }

  return res.json();
}

// Verifica que el webhook realmente venga de Meta (firma HMAC con el App Secret).
// Si no hay WHATSAPP_APP_SECRET configurado, no verifica (no recomendado en producción).
function verifySignature(rawBody, signatureHeader) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) return true;
  if (!signatureHeader) return false;

  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { sendMessage, sendTemplate, verifySignature };
