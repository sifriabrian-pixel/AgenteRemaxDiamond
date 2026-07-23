const fs = require('fs');
const path = require('path');

const STATS_FILE = process.env.SESSION_PATH
  ? path.join(process.env.SESSION_PATH, 'stats.json')
  : path.join(__dirname, '../stats.json');

let events = [];
let instaladoDesde = null;

function load() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      events = data.events || [];
      instaladoDesde = data.instaladoDesde || null;
    }
  } catch (e) {
    console.error('[stats] Error loading:', e.message);
  }
  if (!instaladoDesde) {
    instaladoDesde = new Date().toISOString();
    save();
  }
}

function save() {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify({ events, instaladoDesde }, null, 2));
  } catch (e) {
    console.error('[stats] Error saving:', e.message);
  }
}

function logEvent(tipo, numero) {
  events.push({ tipo, numero, fecha: new Date().toISOString() });
  save();
}

const HANDOFF_TIPOS = [
  'handoff_propietario',
  'handoff_asesor',
  'handoff_comprador',
  'handoff_arrendatario',
  'handoff_general',
];

const FLUJO_TIPOS = ['propietario', 'asesor', 'comprador', 'arrendatario'];

function getStats(fechaFiltro) {
  const filtrados = fechaFiltro
    ? events.filter(e => e.fecha.startsWith(fechaFiltro))
    : events;

  const porTipo = (tipo) => filtrados.filter(e => e.tipo === tipo);
  const unicos = (lista) => new Set(lista.map(e => e.numero)).size;

  const fichas = filtrados.filter(e => HANDOFF_TIPOS.includes(e.tipo));

  const porFlujo = {};
  for (const flujo of FLUJO_TIPOS) {
    porFlujo[flujo] = unicos(porTipo(`flujo_${flujo}`));
  }

  return {
    leadsAtendidos: unicos(porTipo('lead_atendido')),
    fichasEnviadas: fichas.length,
    leadsDerivados: unicos(fichas),
    fueraHorario: porTipo('fuera_horario').length,
    porFlujo,
    instaladoDesde,
  };
}

load();

module.exports = { logEvent, getStats };
