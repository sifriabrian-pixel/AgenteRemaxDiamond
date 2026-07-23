// Catálogo de propiedades de RE/MAX Diamond.
//
// La fuente real es el export del MLS de RE/MAX ("Redremax") cruzado con
// data/asesores.json (nombre de agente -> whatsapp), procesado por
// scripts/importar-propiedades.js hacia data/propiedades.json.
//
// Cada propiedad tiene exclusividad de un asesor — por eso, si el lead
// consulta por una propiedad puntual, la derivación va directo a ese asesor
// (ver getAsesorAsignado) en vez de a un asesor de guardia por turno.
//
// El catálogo NO se inyecta entero en el system prompt (con 800+ propiedades
// activas eso son ~30.000 tokens en CADA mensaje). En su lugar, Claude usa la
// herramienta "buscar_propiedades" (ver src/claude.js) y acá solo se filtra
// y se devuelve un puñado de resultados relevantes.
//
// Para actualizar el catálogo: pedir un nuevo export del MLS y correr
//   node scripts/importar-propiedades.js "ruta/al/nuevo-reporte.csv"

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '../data/propiedades.json');
const CACHE_MS = 60 * 1000; // 1 minuto — solo para no releer el archivo en cada mensaje
const MAX_RESULTADOS = 10;
let cache = { data: [], mtimeMs: 0, fetchedAt: 0 };

function leerArchivo() {
  try {
    const stat = fs.statSync(DATA_PATH);
    if (stat.mtimeMs === cache.mtimeMs && Date.now() - cache.fetchedAt < CACHE_MS) {
      return cache.data;
    }
    const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    cache = { data, mtimeMs: stat.mtimeMs, fetchedAt: Date.now() };
    return data;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[propiedades] Error leyendo catálogo:', e.message);
    return cache.data;
  }
}

async function getPropiedades() {
  return leerArchivo();
}

function normalizar(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Filtra el catálogo según lo que pida la herramienta de Claude.
// Devuelve como máximo MAX_RESULTADOS, más el total real de coincidencias
// para que el agente pueda avisar "hay más, ¿podés darme más detalle?".
async function buscarPropiedades(filtros = {}) {
  const propiedades = await getPropiedades();
  let activas = propiedades.filter((p) => (p.estado || '').toLowerCase() === 'activa');

  if (filtros.codigo) {
    const codigo = normalizar(filtros.codigo);
    const encontrada = activas.find((p) => normalizar(p.codigo) === codigo);
    return { total: encontrada ? 1 : 0, resultados: encontrada ? [encontrada] : [] };
  }

  if (filtros.tipo) {
    const tipo = normalizar(filtros.tipo);
    activas = activas.filter((p) => normalizar(p.tipo).includes(tipo));
  }
  if (filtros.operacion) {
    const operacion = normalizar(filtros.operacion);
    activas = activas.filter((p) => normalizar(p.operacion) === operacion);
  }
  if (filtros.sector) {
    const sector = normalizar(filtros.sector);
    activas = activas.filter((p) => normalizar(p.sector).includes(sector));
  }
  if (filtros.dormitorios_min) {
    const min = Number(filtros.dormitorios_min);
    activas = activas.filter((p) => Number(p.dormitorios) >= min);
  }
  if (filtros.precio_min) {
    const min = Number(filtros.precio_min);
    activas = activas.filter((p) => Number(p.precio) >= min);
  }
  if (filtros.precio_max) {
    const max = Number(filtros.precio_max);
    activas = activas.filter((p) => Number(p.precio) <= max);
  }

  return {
    total: activas.length,
    resultados: activas.slice(0, MAX_RESULTADOS),
  };
}

// Cada propiedad tiene un asesor con exclusividad. Si el lead consultó por
// un código puntual, se deriva directo a ese asesor.
async function getAsesorAsignado(codigo) {
  if (!codigo) return null;
  const propiedades = await getPropiedades();
  const propiedad = propiedades.find(p => p.codigo === codigo);
  if (!propiedad || !propiedad.asesorWhatsapp) return null;
  return { nombre: propiedad.asesorNombre || 'Asesor asignado', whatsapp: propiedad.asesorWhatsapp };
}

module.exports = { getPropiedades, buscarPropiedades, getAsesorAsignado };
