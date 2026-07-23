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

module.exports = { get, set, addMessage, reset, getAll };
