const fs = require('fs');
const path = require('path');
const memory = require('./memory');

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
  'handoff_hablar_asesor',
];

const FLUJO_TIPOS = ['propietario', 'asesor', 'comprador', 'arrendatario'];

// % de mensajes que le llegaron al lead (entregado o leído) que efectivamente
// fueron leídos. Se calcula en vivo desde memory.json, no desde el log de
// eventos, porque el estado de lectura vive en el historial de cada lead.
function calcularTasaLectura(fechaFiltro) {
  const todos = memory.getAll();
  const reclutamientoNumero = process.env.WHATSAPP_RECLUTAMIENTO || '';
  let leidos = 0;
  let entregadosOLeidos = 0;

  for (const [numero, estado] of Object.entries(todos)) {
    if (estado.esGuardia || numero === reclutamientoNumero) continue; // hilos internos, no leads
    for (const m of estado.historial || []) {
      if (m.role !== 'assistant' || !m.estadoEnvio) continue;
      if (fechaFiltro && !(m.ts || '').startsWith(fechaFiltro)) continue;
      if (m.estadoEnvio === 'entregado' || m.estadoEnvio === 'leido') {
        entregadosOLeidos++;
        if (m.estadoEnvio === 'leido') leidos++;
      }
    }
  }

  return entregadosOLeidos > 0 ? Math.round((leidos / entregadosOLeidos) * 100) : null;
}

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

  const leadsAtendidos = unicos(porTipo('lead_atendido'));
  const leadsDerivados = unicos(fichas);
  const tasaCalificacion = leadsAtendidos > 0 ? Math.round((leadsDerivados / leadsAtendidos) * 100) : null;

  const conSeguimiento = unicos([...porTipo('seguimiento_30min'), ...porTipo('seguimiento_24h')]);
  const reactivados = unicos(porTipo('reactivado'));
  const tasaReactivacion = conSeguimiento > 0 ? Math.round((reactivados / conSeguimiento) * 100) : null;

  return {
    leadsAtendidos,
    fichasEnviadas: fichas.length,
    leadsDerivados,
    fueraHorario: porTipo('fuera_horario').length,
    porFlujo,
    instaladoDesde,
    tasaCalificacion,
    tasaLectura: calcularTasaLectura(fechaFiltro),
    tasaReactivacion,
    conSeguimiento,
    reactivados,
  };
}

// Categorías clicables desde /stats — cada una mapea a los tipos de evento
// que la componen. "derivados" es un caso especial: se dedupe por número
// (un lead puede tener varios eventos de handoff a lo largo del tiempo, pero
// para el listado solo importa el más reciente).
const CATEGORIAS = {
  atendidos: ['lead_atendido'],
  fichas: HANDOFF_TIPOS,
  derivados: HANDOFF_TIPOS,
  fuera_horario: ['fuera_horario'],
  reactivados: ['reactivado'],
  flujo_propietario: ['flujo_propietario'],
  flujo_asesor: ['flujo_asesor'],
  flujo_comprador: ['flujo_comprador'],
  flujo_arrendatario: ['flujo_arrendatario'],
};

function listarPorCategoria(categoria, fechaFiltro) {
  const tipos = CATEGORIAS[categoria];
  if (!tipos) return [];

  const filtrados = fechaFiltro
    ? events.filter(e => e.fecha.startsWith(fechaFiltro))
    : events;
  const lista = filtrados.filter(e => tipos.includes(e.tipo));

  if (categoria !== 'derivados') {
    return [...lista].sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  }

  // Un lead por fila, quedándose con el evento de handoff más reciente
  const porNumero = new Map();
  for (const e of lista) {
    const anterior = porNumero.get(e.numero);
    if (!anterior || e.fecha > anterior.fecha) porNumero.set(e.numero, e);
  }
  return [...porNumero.values()].sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
}

load();

module.exports = { logEvent, getStats, listarPorCategoria };
