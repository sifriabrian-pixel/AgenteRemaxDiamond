// Propiedades que RE/MAX Diamond está pautando activamente en redes (Meta
// Ads, etc.). A diferencia del catálogo general, para ESTAS SÍ le pasamos la
// ficha completa al lead (vía el link oficial) y lo derivamos directo al
// asesor a cargo, sin pasar por las preguntas de calificación.
//
// Para actualizar esta lista: pedir el doc actualizado a Diamond y volver a
// generar este archivo (incluir el WhatsApp del asesor, cruzando contra
// data/asesores.json, igual que hace scripts/importar-propiedades.js).
const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '../data/propiedades_pautadas.json');

function getPautadas() {
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[pautadas] Error leyendo lista:', e.message);
    return [];
  }
}

function getPautadaPorId(id) {
  return getPautadas().find((p) => p.id === id) || null;
}

module.exports = { getPautadas, getPautadaPorId };
