// Calcula, en código (no le pedimos a Claude que haga cuentas de fechas —
// se equivoca fácil), las dos opciones de horario que Diamantito debe
// ofrecer en el cierre de un flujo, según la fecha/hora real del sistema.
const { FERIADOS, getTimezoneDate, formatFechaISO, APERTURA_MIN, CIERRE_MIN } = require('./guardias');

const UMBRAL_CIERRE_MIN = 120; // "faltan menos de 2 horas para cerrar"
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function esDiaHabil(fecha) {
  const dia = fecha.getDay();
  if (dia === 0 || dia === 6) return false;
  return !FERIADOS.has(formatFechaISO(fecha));
}

function siguienteDiaHabil(fecha) {
  const siguiente = new Date(fecha);
  do {
    siguiente.setDate(siguiente.getDate() + 1);
  } while (!esDiaHabil(siguiente));
  return siguiente;
}

// "mañana" si el próximo día hábil es literalmente el día calendario
// siguiente; si hay que saltar fin de semana/feriado, usa el nombre del día
// ("el lunes") — nunca lo dejamos como texto fijo en el prompt.
function etiquetaProximoDiaHabil(ahora) {
  const proximo = siguienteDiaHabil(ahora);
  const maniana = new Date(ahora);
  maniana.setDate(maniana.getDate() + 1);
  const esLiteralmenteManiana = formatFechaISO(proximo) === formatFechaISO(maniana);
  return esLiteralmenteManiana ? 'mañana' : `el ${DIAS[proximo.getDay()]}`;
}

// Devuelve el texto que se le agrega al contexto de la conversación (system
// prompt dinámico), con instrucciones listas para usar — nunca le pedimos a
// Claude que infiera el día/hora por su cuenta.
function calcularOpcionesHorario(esUrgente) {
  const ahora = getTimezoneDate();
  const minutosHoy = ahora.getHours() * 60 + ahora.getMinutes();
  const hoyEsHabil = esDiaHabil(ahora);
  const enHorario = hoyEsHabil && minutosHoy >= APERTURA_MIN && minutosHoy < CIERRE_MIN;
  const minutosParaCierre = CIERRE_MIN - minutosHoy;

  if (esUrgente) {
    if (enHorario) {
      return 'Este lead está marcado URGENTE y estamos en horario de atención. En el cierre, NO ofrezca opción A/B de horario — pregunte directo: "¿lo llamamos ahora mismo?".';
    }
    return 'Este lead está marcado URGENTE pero estamos FUERA de horario de atención. En el cierre, avísele explícitamente que está fuera del horario de atención, y comprométase a que sea el primer contacto del próximo día hábil (no ofrezca opción A/B).';
  }

  if (enHorario && minutosParaCierre > UMBRAL_CIERRE_MIN) {
    return 'Estamos en horario de atención y falta más de 2 horas para cerrar. Si el flujo llega al cierre, ofrezca como opción A "hoy más tarde" y como opción B "mañana".';
  }

  const etiqueta = etiquetaProximoDiaHabil(ahora);
  return `Estamos fuera de la ventana para agendar algo para hoy (fuera de horario de atención, o falta menos de 2 horas para cerrar). Si el flujo llega al cierre, ofrezca como opción A "${etiqueta} por la mañana" y como opción B "${etiqueta} por la tarde".`;
}

module.exports = { calcularOpcionesHorario };
