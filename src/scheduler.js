const cron = require('node-cron');
const memory = require('./memory');
const whatsapp = require('./whatsapp');
const stats = require('./stats');
const { getAsesorDeGuardia } = require('./guardias');

const ZONA = 'America/Guayaquil';

function motivoConsulta(estado) {
  const op = estado.datos?.operacion;
  switch (estado.flujo) {
    case 'propietario':
      if (op === 'arriendo') return 'Arriendo de propiedad';
      if (op === 'venta') return 'Venta de propiedad';
      return 'Venta o arriendo de propiedad';
    case 'asesor':
      return 'Postulación a asesor';
    case 'comprador':
      return 'Compra de propiedad';
    case 'arrendatario':
      return 'Alquiler de propiedad';
    default:
      return 'Sin clasificar';
  }
}

function init() {
  // Cada minuto: revisar follow-ups de propietarios fuera de horario
  cron.schedule('* * * * *', async () => {
    const asesor = await getAsesorDeGuardia();
    if (!asesor) return;

    const todos = memory.getAll();
    for (const [numero, estado] of Object.entries(todos)) {
      if (estado.followupPendiente && estado.flujo === 'propietario' && estado.datos?.handoffListo) {
        try {
          await enviarResumenPropietario(asesor, numero, estado.datos);
          memory.set(numero, { followupPendiente: false });
          console.log(`[scheduler] Resumen enviado a ${asesor.nombre} por lead ${numero}`);
        } catch (e) {
          console.error('[scheduler] Error enviando resumen:', e.message);
        }
      }
    }
  });

  // Leads que dejaron de responder a mitad del flujo (sin calificar todavía):
  // un mensaje a los 30 min, y uno solo a las 24hs (ya no hay más seguimientos
  // después de eso). Se revisa cada 5 minutos para no perder el corte de 30 min.
  const reclutamientoNumero = process.env.WHATSAPP_RECLUTAMIENTO || '';
  cron.schedule('*/5 * * * *', async () => {
    const ahora = new Date();
    const todos = memory.getAll();

    for (const [numero, estado] of Object.entries(todos)) {
      if (!estado.ultimoMensaje) continue;
      if (estado.esGuardia || numero === reclutamientoNumero) continue; // hilos internos, no leads
      if (estado.datos?.handoffListo) continue; // ya calificó, no hace falta insistir

      const diffMin = (ahora - new Date(estado.ultimoMensaje)) / 1000 / 60;

      if (diffMin >= 1440 && !estado.followup24h) {
        await enviarFollowup(numero, estado, '24h');
        memory.set(numero, { followup24h: true });
        stats.logEvent('seguimiento_24h', numero);
      } else if (diffMin >= 30 && !estado.followup30min) {
        await enviarFollowup(numero, estado, '30min');
        memory.set(numero, { followup30min: true });
        stats.logEvent('seguimiento_30min', numero);
      }
    }
  });

  // Todos los viernes a las 18:00 (hora Ecuador): listado de leads que quedaron
  // sin calificar en la semana, para que la oficina los retome de forma proactiva.
  cron.schedule('0 18 * * 5', async () => {
    try {
      await enviarReporteSemanal();
    } catch (e) {
      console.error('[scheduler] Error enviando reporte semanal:', e.message);
    }
  }, { timezone: ZONA });
}

async function enviarFollowup(numero, estado, tipo) {
  const nombre = estado.datos?.nombre || '';

  if (tipo === '24h') {
    // Fuera de la ventana de servicio de 24hs — obligatorio usar plantilla aprobada.
    try {
      await whatsapp.sendTemplate(numero, 'recordatorio_24h', 'es_EC', { nombre: nombre || 'cliente' });
    } catch (e) {
      console.error(`[scheduler] Error enviando recordatorio 24h a ${numero}:`, e.message);
    }
    return;
  }

  if (tipo === '30min') {
    // Dentro de la ventana de servicio de 24hs — puede ser texto libre.
    const texto = `¡Hola${nombre ? ' ' + nombre : ''}! 😊 ¿Seguimos con su consulta? Quedo atento por acá.`;
    try {
      const respuestaWA = await whatsapp.sendMessage(numero, texto);
      memory.addMessage(numero, 'assistant', texto);
      memory.setUltimoEstadoEnvio(numero, 'enviado', respuestaWA?.messages?.[0]?.id || null);
    } catch (e) {
      console.error(`[scheduler] Error enviando seguimiento 30min a ${numero}:`, e.message);
    }
  }
}

async function enviarResumenPropietario(asesor, numeroLead, datos) {
  const resumen = formatResumenPropietario(numeroLead, datos);
  await whatsapp.sendMessage(asesor.whatsapp, resumen);
}

function formatResumenPropietario(telefono, datos) {
  return `🔔 Nuevo lead calificado

Propietario: ${datos.nombre || '-'} · ${telefono}
Relación: ${datos.relacion || '-'}

Propiedad: ${datos.tipo || '-'} ${datos.dormitorios || ''} · ${datos.sector || '-'} · ${datos.superficie || '-'}
Operación: ${datos.operacion || '-'}
Ocupación: ${datos.ocupacion || '-'}
Precio estimado: ${datos.precio || 'necesita tasación'}
Trabaja con otra inmobiliaria: ${datos.otraInmobiliaria || '-'}
Disponibilidad: ${datos.disponibilidad || '-'}

Zona: ${datos.zona || '-'}
Antigüedad: ${datos.antiguedad || 'no informada'}
Prioridad: ${datos.prioridad || 'Media'}
Observación: ${datos.observacion || '-'}`;
}

// Meta no permite saltos de línea ni más de 4 espacios consecutivos en variables de plantilla
function reclutamientoParam(texto) {
  return texto.replace(/\n+/g, ' | ').replace(/\s{5,}/g, '    ');
}

async function enviarReporteSemanal() {
  const reclutamientoNumero = process.env.WHATSAPP_RECLUTAMIENTO;
  if (!reclutamientoNumero) {
    console.warn('[scheduler] WHATSAPP_RECLUTAMIENTO no configurado — reporte semanal no enviado');
    return;
  }

  const todos = memory.getAll();
  const sinContestar = Object.entries(todos).filter(([numero, estado]) => {
    if (estado.esGuardia || numero === reclutamientoNumero) return false;
    if (!estado.historial || estado.historial.length === 0) return false;
    return !estado.datos?.handoffListo;
  });

  if (sinContestar.length === 0) {
    console.log('[scheduler] Reporte semanal: sin leads pendientes, no se envía.');
    return;
  }

  const MAX_LISTADO = 25;
  const lineas = sinContestar.slice(0, MAX_LISTADO).map(([numero, estado]) => {
    const nombre = estado.datos?.nombre || numero;
    return `- ${nombre} · ${numero} · ${motivoConsulta(estado)}`;
  });
  const extra = sinContestar.length > MAX_LISTADO ? `\n… y ${sinContestar.length - MAX_LISTADO} más.` : '';

  const resumen = `📋 REPORTE SEMANAL — Leads sin calificar (${sinContestar.length})\n\n${lineas.join('\n')}${extra}\n\nPara contacto proactivo del equipo.`;

  try {
    await whatsapp.sendTemplate(reclutamientoNumero, 'notificacion_lead_reclutamiento', 'es_EC', { '1': reclutamientoParam(resumen) });
    memory.addMessage(reclutamientoNumero, 'assistant', resumen);
    console.log(`[scheduler] Reporte semanal enviado (${sinContestar.length} leads)`);
  } catch (e) {
    console.error('[scheduler] Error enviando reporte semanal:', e.message);
  }
}

module.exports = { init, enviarResumenPropietario, formatResumenPropietario };
