// Catálogo de propiedades de RE/MAX Diamond.
//
// La fuente real es el export del MLS de RE/MAX ("Redremax") cruzado con
// data/asesores.json (nombre de agente -> whatsapp), procesado por
// scripts/importar-propiedades.js hacia data/propiedades.json.
//
// Diamantito NO consulta este catálogo — no asesora sobre propiedades
// puntuales (ver prompts/diamond.js). Este módulo solo se usa server-side,
// para encontrar el asesor con exclusividad de una propiedad cuando el lead
// menciona un código puntual (así se deriva directo a esa persona en vez de
// caer al backup de oficina).
//
// Para actualizar el catálogo: pedir un nuevo export del MLS y correr
//   node scripts/importar-propiedades.js "ruta/al/nuevo-reporte.csv"

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '../data/propiedades.json');
const CACHE_MS = 60 * 1000; // 1 minuto — solo para no releer el archivo en cada mensaje
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

// Cada propiedad tiene un asesor con exclusividad. Si el lead consultó por
// un código puntual, se deriva directo a ese asesor.
async function getAsesorAsignado(codigo) {
  if (!codigo) return null;
  const propiedades = await getPropiedades();
  const propiedad = propiedades.find(p => p.codigo === codigo);
  if (!propiedad || !propiedad.asesorWhatsapp) return null;
  return { nombre: propiedad.asesorNombre || 'Asesor asignado', whatsapp: propiedad.asesorWhatsapp };
}

module.exports = { getPropiedades, getAsesorAsignado };
