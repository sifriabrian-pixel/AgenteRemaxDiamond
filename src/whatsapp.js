const crypto = require('crypto');

const GRAPH_VERSION = 'v21.0';

function phoneNumberId() {
  return process.env.WHATSAPP_PHONE_NUMBER_ID;
}

function token() {
  return process.env.WHATSAPP_TOKEN;
}

async function sendMessage(to, text) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId()}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
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
    to,
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
