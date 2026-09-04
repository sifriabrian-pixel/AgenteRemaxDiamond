const cron = require('node-cron');
const memory = require('./memory');
const whatsapp = require('./whatsapp');
const { getAsesorDeGuardia } = require('./guardias');

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

  // Follow-ups a leads que no completaron (revisar cada hora)
  cron.schedule('0 * * * *', async () => {
    const ahora = new Date();
    const todos = memory.getAll();

    for (const [numero, estado] of Object.entries(todos)) {
      if (!estado.ultimoMensaje) continue;
      const diff = (ahora - new Date(estado.ultimoMensaje)) / 1000 / 60 / 60; // horas

      if (estado.flujo === 'propietario' && !estado.datos?.handoffListo) {
        if (diff >= 48) {
          await enviarFollowup(numero, estado, '48h_propietario');
        } else if (diff >= 24 && !estado.followup24h) {
          await enviarFollowup(numero, estado, '24h_propietario');
          memory.set(numero, { followup24h: true });
        }
      }

      if (estado.flujo === 'asesor' && !estado.datos?.handoffListo) {
        if (diff >= 168 && !estado.followup7d) { // 7 días
          await enviarFollowup(numero, estado, '7d_asesor');
          memory.set(numero, { followup7d: true });
        } else if (diff >= 72 && !estado.followup72h) {
          await enviarFollowup(numero, estado, '72h_asesor');
          memory.set(numero, { followup72h: true });
        } else if (diff >= 24 && !estado.followup24h) {
          await enviarFollowup(numero, estado, '24h_asesor');
          memory.set(numero, { followup24h: true });
        }
      }

      // Reactivar propietarios fuera de cobertura a los 30 días (por si cambió su situación)
      if (estado.datos?.fueraCobertura && diff >= 720 && !estado.followup30d_cobertura) {
        await enviarFollowup(numero, estado, '30d_cobertura');
        memory.set(numero, { followup30d_cobertura: true });
      }

      // Reactivar asesores descalificados a los 30 días
      if (estado.flujo === 'asesor' && estado.datos?.descalificado && diff >= 720 && !estado.followup30d) {
        await enviarFollowup(numero, estado, '30d_asesor');
        memory.set(numero, { followup30d: true });
      }
    }
  });
}

async function enviarFollowup(numero, estado, tipo) {
  const nombre = estado.datos?.nombre || '';
  let texto = '';

  // Todos los follow-ups usan plantillas aprobadas (obligatorio fuera de la ventana de 24hs)
  // 24h_propietario y 24h_asesor comparten la misma plantilla genérica (recordatorio_24h)
  const plantillas = {
    '24h_propietario': () => whatsapp.sendTemplate(numero, 'recordatorio_24h', 'es_EC', { nombre: nombre || 'cliente' }),
    '24h_asesor':  () => whatsapp.sendTemplate(numero, 'recordatorio_24h',      'es_EC', { nombre: nombre || 'cliente' }),
    '72h_asesor':  () => whatsapp.sendTemplate(numero, 'seguimiento_asesor_72h', 'es_EC', { nombre: nombre || 'cliente' }),
    '7d_asesor':   () => whatsapp.sendTemplate(numero, 'seguimiento_asesor_7d',  'es_EC', { nombre: nombre || 'cliente' }),
    '30d_asesor':  () => whatsapp.sendTemplate(numero, 'reactivacion_asesor_30d', 'es_EC', { nombre: nombre || 'cliente' }),
  };

  if (plantillas[tipo]) {
    try {
      await plantillas[tipo]();
    } catch (e) {
      console.error(`[scheduler] Error enviando plantilla ${tipo} a ${numero}:`, e.message);
    }
    return;
  }

  switch (tipo) {
    case '48h_propietario':
      texto = `${nombre || 'Hola'}, solo quería asegurarme de que no quedó con dudas. Cuando quiera retomar, acá estamos 🏠`;
      break;
    case '30d_cobertura':
      texto = `¡Hola${nombre ? ' ' + nombre : ''}! Le escribo desde RE/MAX Diamond. ¿Su propiedad sigue disponible? Si la situación cambió y necesita apoyo, con gusto le orientamos 🏠`;
      break;
  }

  if (texto) {
    try {
      await whatsapp.sendMessage(numero, texto);
    } catch (e) {
      console.error(`[scheduler] Error enviando followup ${tipo} a ${numero}:`, e.message);
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

module.exports = { init, enviarResumenPropietario, formatResumenPropietario };
