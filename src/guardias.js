const { google } = require('googleapis');

// Feriados Ecuador 2025 y 2026 (nacionales — aplican también en Manta)
const FERIADOS = new Set([
  // 2025
  '2025-01-01', // Año Nuevo
  '2025-02-03', // Carnaval
  '2025-02-04', // Carnaval
  '2025-04-18', // Viernes Santo
  '2025-05-01', // Día del Trabajo
  '2025-05-24', // Batalla de Pichincha
  '2025-08-10', // Primer Grito de Independencia
  '2025-10-09', // Independencia de Guayaquil
  '2025-11-02', // Día de los Difuntos
  '2025-11-03', // Independencia de Cuenca
  '2025-12-25', // Navidad
  // 2026
  '2026-01-01', // Año Nuevo
  '2026-02-16', // Carnaval
  '2026-02-17', // Carnaval
  '2026-04-03', // Viernes Santo
  '2026-05-01', // Día del Trabajo
  '2026-05-24', // Batalla de Pichincha (trasladado al lunes 25)
  '2026-05-25', // Batalla de Pichincha (traslado)
  '2026-08-10', // Primer Grito de Independencia
  '2026-10-09', // Independencia de Guayaquil
  '2026-11-02', // Día de los Difuntos
  '2026-11-03', // Independencia de Cuenca
  '2026-12-25', // Navidad
]);

// Horario de atención confirmado: lunes a viernes, 9:00 a 18:00.
const APERTURA_MIN = 9 * 60;
const CIERRE_MIN = 18 * 60;

let guardiaOverride = null;

function getSheets() {
  const keyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyRaw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY no configurada');
  const credentials = JSON.parse(Buffer.from(keyRaw, 'base64').toString('utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

function formatDate(date) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

// yyyy-mm-dd, para comparar contra las claves de FERIADOS (formatDate() da
// dd/mm/yyyy, que es lo que espera el Sheet de guardias, no FERIADOS).
function formatFechaISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getTimezoneDate() {
  // America/Guayaquil = UTC-5 (incluye Manta)
  const utc = new Date();
  const offsetMs = -5 * 60 * 60 * 1000;
  return new Date(utc.getTime() + offsetMs);
}

async function buscarEnSheet(fecha, turno) {
  try {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: "'RE/MAX Diamond — Sistema de Guardias (TEMPLATE)'!A:D",
    });
    const rows = res.data.values || [];
    for (const row of rows.slice(1)) { // slice(1) salta la fila de encabezados
      if (row[0] === fecha && row[1] === turno) {
        return { nombre: row[2], whatsapp: row[3] };
      }
    }
    return null;
  } catch (e) {
    console.error('[guardias] Error consultando sheet:', e.message);
    return null;
  }
}

async function getAsesorDeGuardia() {
  // 1. Override activo
  if (guardiaOverride && new Date() < guardiaOverride.hasta) {
    return guardiaOverride.asesor;
  }

  const ahora = getTimezoneDate();
  const dia = ahora.getDay(); // 0=dom, 6=sab
  const hora = ahora.getHours() * 60 + ahora.getMinutes();
  const fecha = formatDate(ahora);

  // 2. Fin de semana
  if (dia === 0 || dia === 6) return null;

  // 3. Feriado
  if (FERIADOS.has(formatFechaISO(ahora))) return null;

  // 4. Fuera de horario (9:00–18:00)
  if (hora < APERTURA_MIN || hora >= CIERRE_MIN) return null;

  const turno = hora < (APERTURA_MIN + CIERRE_MIN) / 2 ? 'mañana' : 'tarde';

  return await buscarEnSheet(fecha, turno);
}

function setOverride(nombre, whatsapp, hastaHora) {
  const ahora = getTimezoneDate();
  const [h, m] = hastaHora.split(':').map(Number);
  const hasta = new Date(ahora);
  hasta.setHours(h, m, 0, 0);
  guardiaOverride = { asesor: { nombre, whatsapp }, hasta };
  console.log(`[guardias] Override activado: ${nombre} hasta ${hastaHora}`);
}

function clearOverride() {
  guardiaOverride = null;
}

function estaEnHorario() {
  const ahora = getTimezoneDate();
  const dia = ahora.getDay();
  const hora = ahora.getHours() * 60 + ahora.getMinutes();
  if (dia === 0 || dia === 6) return false;
  if (FERIADOS.has(formatFechaISO(ahora))) return false;
  return hora >= APERTURA_MIN && hora < CIERRE_MIN;
}

module.exports = {
  getAsesorDeGuardia, setOverride, clearOverride, estaEnHorario,
  FERIADOS, getTimezoneDate, formatFechaISO, APERTURA_MIN, CIERRE_MIN,
};
