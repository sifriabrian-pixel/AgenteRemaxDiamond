const fs = require('fs');
const path = require('path');

const MEMORY_FILE = process.env.SESSION_PATH
  ? path.join(process.env.SESSION_PATH, 'memory.json')
  : path.join(__dirname, '../memory.json');

const conversations = {};

function load() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
      Object.assign(conversations, data);
    }
  } catch (e) {
    console.error('[memory] Error loading:', e.message);
  }
}

function save() {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(conversations, null, 2));
  } catch (e) {
    console.error('[memory] Error saving:', e.message);
  }
}

function get(numero) {
  if (!conversations[numero]) {
    conversations[numero] = {
      flujo: null,
      paso: 0,
      datos: {},
      consentimiento: false,
      historial: [],
      ultimoMensaje: null,
      followupPendiente: false,
    };
  }
  return conversations[numero];
}

function set(numero, estado) {
  conversations[numero] = { ...conversations[numero], ...estado };
  save();
}

const MAX_HISTORIAL = 40; // 20 turnos completos (user + assistant)

function addMessage(numero, role, content) {
  const estado = get(numero);
  estado.historial.push({ role, content, ts: new Date().toISOString() });
  // Mantener solo los últimos MAX_HISTORIAL mensajes
  if (estado.historial.length > MAX_HISTORIAL) {
    estado.historial = estado.historial.slice(-MAX_HISTORIAL);
  }
  estado.ultimoMensaje = new Date().toISOString();
  save();
}

// Guarda el id de mensaje de WhatsApp del ÚLTIMO mensaje agregado, para poder
// después cruzarlo con los eventos de estado (enviado/entregado/leído) que
// manda Meta por webhook.
function setUltimoEstadoEnvio(numero, estadoEnvio, waMessageId) {
  const estado = get(numero);
  const ultimo = estado.historial[estado.historial.length - 1];
  if (!ultimo) return;
  ultimo.estadoEnvio = estadoEnvio;
  if (waMessageId) ultimo.waMessageId = waMessageId;
  save();
}

// Rango de progreso de un mensaje: solo avanza (enviado → entregado → leído),
// nunca retrocede, por si los eventos de Meta llegan desordenados.
const RANGO_ESTADO = { enviado: 1, entregado: 2, leido: 3, fallido: 1 };

function setMessageStatus(waMessageId, estadoNuevo) {
  for (const numero of Object.keys(conversations)) {
    const historial = conversations[numero].historial || [];
    for (const m of historial) {
      if (m.waMessageId === waMessageId) {
        const actual = m.estadoEnvio;
        if (!actual || (RANGO_ESTADO[estadoNuevo] || 0) >= (RANGO_ESTADO[actual] || 0)) {
          m.estadoEnvio = estadoNuevo;
        }
        save();
        return true;
      }
    }
  }
  return false;
}

function reset(numero) {
  conversations[numero] = {
    flujo: null,
    paso: 0,
    datos: {},
    consentimiento: false,
    historial: [],
    ultimoMensaje: null,
    followupPendiente: false,
  };
  save();
}

function getAll() {
  return conversations;
}

load();

module.exports = { get, set, addMessage, reset, getAll, setUltimoEstadoEnvio, setMessageStatus };
