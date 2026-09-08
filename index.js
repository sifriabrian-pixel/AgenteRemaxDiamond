require('dotenv').config();
const http = require('http');

const { chat, extraerDatos } = require('./src/claude');
const memory = require('./src/memory');
const scheduler = require('./src/scheduler');
const guardias = require('./src/guardias');
const propiedades = require('./src/propiedades');
const stats = require('./src/stats');
const whatsapp = require('./src/whatsapp');

const NUMEROS_AUTORIZADOS = (process.env.NUMEROS_AUTORIZADOS || '').split(',').map(n => n.trim()).filter(Boolean);
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

const TRIGGERS = [
  'HANDOFF_PROPIETARIO',
  'FOLLOWUP_PROPIETARIO',
  'FOLLOWUP_PROPIETARIO_FUERA_COBERTURA',
  'HANDOFF_ASESOR',
  'FOLLOWUP_ASESOR',
  'HANDOFF_COMPRADOR',
  'HANDOFF_ARRENDATARIO',
  'HANDOFF_GENERAL',
  'HANDOFF_HABLAR_ASESOR',
  'CONSENT_GRANTED',
  'FLUJO_PROPIETARIO',
  'FLUJO_ASESOR',
  'FLUJO_COMPRADOR',
  'FLUJO_ARRENDATARIO',
  'FLUJO_HABLAR_ASESOR',
];

function extractTrigger(text) {
  for (const t of TRIGGERS) {
    if (text.includes(`[${t}]`)) return t;
  }
  return null;
}

function cleanResponse(text) {
  let cleaned = text;
  for (const t of TRIGGERS) {
    cleaned = cleaned.replace(new RegExp(`\\[${t}\\]`, 'g'), '');
  }
  // [PRIORIDAD_ALTA: ...] lleva contenido variable, no matchea el patrón fijo de arriba
  cleaned = cleaned.replace(/\[PRIORIDAD_ALTA:[^\]]*\]/g, '');
  // Colapsar líneas vacías múltiples que dejan los tags y limpiar bordes
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

// Meta no permite saltos de línea ni más de 4 espacios consecutivos en variables de plantilla
function reclutamientoParam(texto) {
  return texto.replace(/\n+/g, ' | ').replace(/\s{5,}/g, '    ');
}

// Notifica al asesor con exclusividad sobre la propiedad (plantilla aprobada —
// no se puede mandar texto libre porque el asesor no le escribió antes al bot).
async function notificarAsesor(numero, resumen) {
  await whatsapp.sendTemplate(numero, 'notificacion_derivacion_asesorv2', 'es_EC', { '1': reclutamientoParam(resumen) });
}

function formatResumenAsesor(telefono, datos) {
  return `🔔 RECLUTAMIENTO — Nuevo prospecto asesor calificado

Oficina: RE/MAX Diamond
Nombre: ${datos.nombre || '-'} · ${telefono}
Correo: ${datos.correo || '-'}
Edad: ${datos.edad || '-'}
Ciudad: ${datos.ciudad || '-'}
Cómo se enteró: ${datos.comoSeEntero || '-'}

Experiencia: ${datos.experiencia || '-'}
Situación actual: ${datos.situacion || '-'}
Disponibilidad: ${datos.disponibilidad || '-'}
Motivación: ${datos.motivacion || '-'}
Otra inmobiliaria: ${datos.otraInmobiliaria || '-'}
Fondo inicial: ${datos.fondoInicial || '-'}
Modelo comisión: ${datos.modeloComision || '-'}
Hoja de vida: ${datos.cvDisponible || '-'}

[Queda a la espera de tu contacto.]`;
}

function formatResumenComprador(telefono, datos) {
  return `🔔 Nuevo lead comprador

Contacto: ${datos.nombre || '-'} · ${telefono}
Tipo: ${datos.tipo || '-'}
Sector: ${datos.sector || '-'}
Dormitorios: ${datos.dormitorios || '-'}
Presupuesto: ${datos.presupuesto || '-'}
Propiedad consultada: ${datos.codigoPropiedad || '-'}`;
}

function formatResumenArrendatario(telefono, datos) {
  return `🔔 Nuevo lead arrendatario

Contacto: ${datos.nombre || '-'} · ${telefono}
Tiempo de alquiler deseado: ${datos.tiempoAlquiler || '-'}
Tipo: ${datos.tipo || '-'}
Sector: ${datos.sector || '-'}
Dormitorios: ${datos.dormitorios || '-'}
Mascotas: ${datos.mascotas || '-'} · Estacionamiento: ${datos.estacionamiento || '-'} · Ascensor: ${datos.ascensor || '-'}
Presupuesto mensual: ${datos.presupuesto || '-'}
Propiedad consultada: ${datos.codigoPropiedad || '-'}`;
}

// Cada propiedad tiene exclusividad de un asesor (no hay sistema de guardia por
// turno en Diamond). Si el lead consultó por una propiedad puntual, se deriva
// directo a ese asesor. Si no hay propiedad puntual o no se encontró asesor
// asignado, cae al número de backup de la oficina.
function asesorBackup() {
  const wa = process.env.WHATSAPP_BACKUP;
  return wa ? { nombre: 'Backup oficina', whatsapp: wa } : null;
}

async function resolverAsesor(datos) {
  const asignado = await propiedades.getAsesorAsignado(datos?.codigoPropiedad);
  if (asignado) return asignado;
  return asesorBackup();
}

async function handleTrigger(trigger, numeroLimpio, datos) {
  try {
    switch (trigger) {
      case 'HANDOFF_PROPIETARIO': {
        const asesor = asesorBackup();
        if (asesor) {
          const resumen = scheduler.formatResumenPropietario(numeroLimpio, datos);
          try {
            await whatsapp.sendTemplate(asesor.whatsapp, 'notificacion_lead_reclutamiento', 'es_EC', { '1': reclutamientoParam(resumen) });
            memory.set(asesor.whatsapp, { esGuardia: true, nombreGuardia: asesor.nombre });
            memory.addMessage(asesor.whatsapp, 'assistant', resumen);
          } catch (e) {
            console.error(`[handoff] FALLO notificación (propietario):`, e.message);
          }
          memory.set(numeroLimpio, { datos: { ...datos, handoffListo: true, asesorAsignado: asesor } });
          stats.logEvent('handoff_propietario', numeroLimpio);
          console.log(`[handoff] Propietario derivado a ${asesor.nombre}`);
        } else {
          memory.set(numeroLimpio, {
            followupPendiente: true,
            datos: { ...datos, handoffListo: true },
          });
          stats.logEvent('fuera_horario', numeroLimpio);
          console.log('[handoff] Fuera de horario — lead encolado');
          if (process.env.WHATSAPP_RECLUTAMIENTO) {
            try {
              const resumenReclutamiento = `📋 CAPTACIÓN — Fuera de horario (sin asesor asignado)\n\n` + scheduler.formatResumenPropietario(numeroLimpio, datos);
              await whatsapp.sendTemplate(process.env.WHATSAPP_RECLUTAMIENTO, 'notificacion_lead_reclutamiento', 'es_EC', { '1': reclutamientoParam(resumenReclutamiento) });
              memory.addMessage(process.env.WHATSAPP_RECLUTAMIENTO, 'assistant', resumenReclutamiento);
            } catch (e) {
              console.error(`[handoff] FALLO notificación (propietario fuera horario):`, e.message);
            }
          }
        }
        break;
      }

      case 'FOLLOWUP_PROPIETARIO': {
        memory.set(numeroLimpio, {
          followupPendiente: true,
          datos: { ...datos, handoffListo: true },
        });
        stats.logEvent('fuera_horario', numeroLimpio);
        console.log('[followup] Propietario encolado para próximo turno');
        break;
      }

      case 'FOLLOWUP_PROPIETARIO_FUERA_COBERTURA': {
        memory.set(numeroLimpio, {
          datos: { ...datos, fueraCobertura: true },
        });
        console.log('[followup] Propietario fuera de cobertura — registrado para 30 días');
        break;
      }

      case 'HANDOFF_ASESOR': {
        const resumen = formatResumenAsesor(numeroLimpio, datos);
        if (process.env.WHATSAPP_RECLUTAMIENTO) {
          try {
            await whatsapp.sendTemplate(process.env.WHATSAPP_RECLUTAMIENTO, 'notificacion_lead_reclutamiento', 'es_EC', { '1': reclutamientoParam(resumen) });
            memory.addMessage(process.env.WHATSAPP_RECLUTAMIENTO, 'assistant', resumen);
            console.log(`[handoff] Asesor enviado a reclutamiento`);
          } catch (e) {
            console.error(`[handoff] FALLO envío (asesor):`, e.message);
          }
        } else {
          console.warn('[handoff] WHATSAPP_RECLUTAMIENTO no configurado — asesor sin notificar');
        }
        memory.set(numeroLimpio, { datos: { ...datos, handoffListo: true } });
        stats.logEvent('handoff_asesor', numeroLimpio);
        break;
      }

      case 'FOLLOWUP_ASESOR': {
        memory.set(numeroLimpio, {
          datos: { ...datos, descalificado: datos.descalificado || false },
        });
        console.log('[followup] Asesor registrado para follow-up');
        break;
      }

      case 'HANDOFF_COMPRADOR': {
        const asesorC = await resolverAsesor(datos);
        const resumenC = formatResumenComprador(numeroLimpio, datos);
        if (asesorC) {
          try {
            await notificarAsesor(asesorC.whatsapp, resumenC);
            memory.set(asesorC.whatsapp, { esGuardia: true, nombreGuardia: asesorC.nombre });
            memory.addMessage(asesorC.whatsapp, 'assistant', resumenC);
            console.log(`[handoff] Comprador derivado a ${asesorC.nombre}`);
          } catch (e) {
            console.error(`[handoff] FALLO notificación (comprador):`, e.message);
          }
          // CC a reclutamiento solo si el asesor asignado es una persona distinta
          // (si no hay asesor exclusivo, ya cae en el mismo número y sería duplicado)
          if (process.env.WHATSAPP_RECLUTAMIENTO && asesorC.whatsapp !== process.env.WHATSAPP_RECLUTAMIENTO) {
            try {
              const resumenReclutamiento = `🔔 COMPRADOR — Lead derivado a ${asesorC.nombre}\n\n` + resumenC;
              await whatsapp.sendTemplate(process.env.WHATSAPP_RECLUTAMIENTO, 'notificacion_lead_reclutamiento', 'es_EC', { '1': reclutamientoParam(resumenReclutamiento) });
              memory.addMessage(process.env.WHATSAPP_RECLUTAMIENTO, 'assistant', resumenReclutamiento);
            } catch (e) {
              console.error(`[handoff] FALLO notificación (comprador):`, e.message);
            }
          }
        } else {
          memory.set(numeroLimpio, { followupPendiente: true });
          console.log('[handoff] Comprador fuera de horario — encolado');
          if (process.env.WHATSAPP_RECLUTAMIENTO) {
            try {
              const resumenReclutamiento = `🔔 COMPRADOR — Fuera de horario (sin asesor asignado)\n\n` + resumenC;
              await whatsapp.sendTemplate(process.env.WHATSAPP_RECLUTAMIENTO, 'notificacion_lead_reclutamiento', 'es_EC', { '1': reclutamientoParam(resumenReclutamiento) });
              memory.addMessage(process.env.WHATSAPP_RECLUTAMIENTO, 'assistant', resumenReclutamiento);
            } catch (e) {
              console.error(`[handoff] FALLO notificación (comprador fuera horario):`, e.message);
            }
          }
        }
        memory.set(numeroLimpio, { datos: { ...datos, handoffListo: true, asesorAsignado: asesorC } });
        stats.logEvent('handoff_comprador', numeroLimpio);
        break;
      }

      case 'HANDOFF_ARRENDATARIO': {
        const asesorA = await resolverAsesor(datos);
        const resumenA = formatResumenArrendatario(numeroLimpio, datos);
        if (asesorA) {
          try {
            await notificarAsesor(asesorA.whatsapp, resumenA);
            memory.set(asesorA.whatsapp, { esGuardia: true, nombreGuardia: asesorA.nombre });
            memory.addMessage(asesorA.whatsapp, 'assistant', resumenA);
            console.log(`[handoff] Arrendatario derivado a ${asesorA.nombre}`);
          } catch (e) {
            console.error(`[handoff] FALLO notificación (arrendatario):`, e.message);
          }
          if (process.env.WHATSAPP_RECLUTAMIENTO && asesorA.whatsapp !== process.env.WHATSAPP_RECLUTAMIENTO) {
            try {
              const resumenReclutamiento = `🔔 ARRENDATARIO — Lead derivado a ${asesorA.nombre}\n\n` + resumenA;
              await whatsapp.sendTemplate(process.env.WHATSAPP_RECLUTAMIENTO, 'notificacion_lead_reclutamiento', 'es_EC', { '1': reclutamientoParam(resumenReclutamiento) });
              memory.addMessage(process.env.WHATSAPP_RECLUTAMIENTO, 'assistant', resumenReclutamiento);
            } catch (e) {
              console.error(`[handoff] FALLO notificación (arrendatario):`, e.message);
            }
          }
        } else {
          memory.set(numeroLimpio, { followupPendiente: true });
          console.log('[handoff] Arrendatario fuera de horario — encolado');
          if (process.env.WHATSAPP_RECLUTAMIENTO) {
            try {
              const resumenReclutamiento = `🔔 ARRENDATARIO — Fuera de horario (sin asesor asignado)\n\n` + resumenA;
              await whatsapp.sendTemplate(process.env.WHATSAPP_RECLUTAMIENTO, 'notificacion_lead_reclutamiento', 'es_EC', { '1': reclutamientoParam(resumenReclutamiento) });
              memory.addMessage(process.env.WHATSAPP_RECLUTAMIENTO, 'assistant', resumenReclutamiento);
            } catch (e) {
              console.error(`[handoff] FALLO notificación (arrendatario fuera horario):`, e.message);
            }
          }
        }
        memory.set(numeroLimpio, { datos: { ...datos, handoffListo: true, asesorAsignado: asesorA } });
        stats.logEvent('handoff_arrendatario', numeroLimpio);
        break;
      }

      case 'HANDOFF_GENERAL': {
        const asesorG = asesorBackup();
        if (asesorG) {
          const texto = `🔔 Consulta general\n\nContacto: ${numeroLimpio}\nMensaje sin flujo definido. Requiere atención manual.`;
          try {
            await whatsapp.sendTemplate(asesorG.whatsapp, 'notificacion_lead_reclutamiento', 'es_EC', { '1': reclutamientoParam(texto) });
            memory.set(asesorG.whatsapp, { esGuardia: true, nombreGuardia: asesorG.nombre });
            memory.addMessage(asesorG.whatsapp, 'assistant', texto);
            console.log(`[handoff] General derivado a ${asesorG.nombre}`);
          } catch (e) {
            console.error(`[handoff] FALLO notificación (general):`, e.message);
          }
        }
        memory.set(numeroLimpio, { datos: { ...datos, handoffListo: true, asesorAsignado: asesorG || null } });
        stats.logEvent('handoff_general', numeroLimpio);
        break;
      }

      case 'HANDOFF_HABLAR_ASESOR': {
        const asesorH = asesorBackup();
        if (asesorH) {
          const texto = `🔔 Quiere hablar con un asesor\n\nContacto: ${datos.nombre || '-'} · ${numeroLimpio}\n\nPidió hablar directamente con alguien de la oficina, sin pasar por ningún flujo de calificación.`;
          try {
            await whatsapp.sendTemplate(asesorH.whatsapp, 'notificacion_lead_reclutamiento', 'es_EC', { '1': reclutamientoParam(texto) });
            memory.set(asesorH.whatsapp, { esGuardia: true, nombreGuardia: asesorH.nombre });
            memory.addMessage(asesorH.whatsapp, 'assistant', texto);
            console.log(`[handoff] "Hablar con asesor" derivado a ${asesorH.nombre}`);
          } catch (e) {
            console.error(`[handoff] FALLO notificación (hablar con asesor):`, e.message);
          }
        }
        memory.set(numeroLimpio, { datos: { ...datos, handoffListo: true, asesorAsignado: asesorH || null } });
        stats.logEvent('handoff_hablar_asesor', numeroLimpio);
        break;
      }
    }
  } catch (e) {
    console.error(`[handoff] Error procesando ${trigger}:`, e.message);
  }
}

function handleOverrideCommand(texto, numeroLimpio) {
  if (!NUMEROS_AUTORIZADOS.includes(numeroLimpio)) return false;

  // Formato: !guardia nombre completo 593XXXXXXXXX HH:MM
  const match = texto.match(/^!guardia\s+(.+?)\s+(593\d{9})\s+(\d{1,2}:\d{2})$/i);
  if (!match) return 'formato_incorrecto';

  const nombre = match[1].trim();
  const telefono = match[2].trim();
  const hora = match[3].trim();
  guardias.setOverride(nombre, telefono, hora);
  return true;
}

async function procesarMensaje(numeroLimpio, texto) {
  console.log(`[msg] ${numeroLimpio}: ${texto}`);

  // Override de guardia
  if (texto.startsWith('!guardia')) {
    const procesado = handleOverrideCommand(texto, numeroLimpio);
    if (procesado === true) {
      await whatsapp.sendMessage(numeroLimpio, '✅ Override de guardia activado.');
    } else if (procesado === 'formato_incorrecto') {
      await whatsapp.sendMessage(
        numeroLimpio,
        '⚠️ Formato incorrecto. Usá:\n!guardia Nombre Apellido 593XXXXXXXXX HH:MM\n\nEjemplo:\n!guardia Carlos López 593987654321 17:30',
      );
    }
    return;
  }

  const estado = memory.get(numeroLimpio);

  // Si es el primer mensaje de este número, registrar lead atendido
  if (estado.historial.length === 0) {
    stats.logEvent('lead_atendido', numeroLimpio);
  }

  // Si el lead responde después de un seguimiento de 30min/24h, contarlo como
  // reactivado (una sola vez por lead, aunque mande varios mensajes seguidos).
  if ((estado.followup30min || estado.followup24h) && !estado.reactivadoRegistrado && !estado.datos?.handoffListo) {
    stats.logEvent('reactivado', numeroLimpio);
    memory.set(numeroLimpio, { reactivadoRegistrado: true });
  }

  // Agregar mensaje al historial
  memory.addMessage(numeroLimpio, 'user', texto);

  const historial = estado.historial
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(({ role, content }) => ({ role, content }));

  // Llamar a Claude
  let respuesta;
  try {
    respuesta = await chat(historial);
  } catch (e) {
    console.error('[claude] Error:', e.message);
    await whatsapp.sendMessage(numeroLimpio, 'Hubo un inconveniente técnico. Por favor intente nuevamente en unos minutos.');
    return;
  }

  // Detectar triggers (CONSENT_GRANTED y FLUJO_* se procesan aparte — pueden venir junto a otro trigger)
  const trigger = extractTrigger(respuesta);
  const consentEnEstaRespuesta = respuesta.includes('[CONSENT_GRANTED]');
  const textoLimpio = cleanResponse(respuesta);

  // Guardar en el historial la versión limpia (sin triggers) — es lo que
  // realmente recibió el lead, y es lo que debe verse en el dashboard.
  memory.addMessage(numeroLimpio, 'assistant', textoLimpio);

  // Marcar consentimiento si aplica
  if (consentEnEstaRespuesta) {
    memory.set(numeroLimpio, { consentimiento: true });
    console.log(`[consent] Consentimiento registrado para ${numeroLimpio}`);
  }

  // Diamantito puede marcar un lead como urgente/alta prioridad si detecta
  // señales claras (ver prompt). No pisa una prioridad que el equipo ya haya
  // puesto a mano.
  const prioridadMatch = respuesta.match(/\[PRIORIDAD_ALTA:([^\]]*)\]/);
  if (prioridadMatch) {
    const estadoPrioridad = memory.get(numeroLimpio);
    if (!estadoPrioridad.prioridadManual) {
      const motivo = prioridadMatch[1].trim();
      memory.set(numeroLimpio, { prioridad: 'urgente', notaAutomatica: `🤖 Diamantito: ${motivo}` });
      console.log(`[prioridad] "${numeroLimpio}" marcado urgente — ${motivo}`);
    }
  }

  // Detectar el flujo apenas se identifica (para que el dashboard lo muestre desde el primer mensaje)
  const FLUJO_TAGS = {
    FLUJO_PROPIETARIO: 'propietario',
    FLUJO_ASESOR: 'asesor',
    FLUJO_COMPRADOR: 'comprador',
    FLUJO_ARRENDATARIO: 'arrendatario',
    FLUJO_HABLAR_ASESOR: 'hablar_asesor',
  };
  for (const [tag, flujo] of Object.entries(FLUJO_TAGS)) {
    if (respuesta.includes(`[${tag}]`)) {
      memory.set(numeroLimpio, { flujo });
      console.log(`[flujo] Detectado "${flujo}" para ${numeroLimpio}`);
      break;
    }
  }

  // Enviar respuesta al usuario
  if (textoLimpio) {
    try {
      const respuestaWA = await whatsapp.sendMessage(numeroLimpio, textoLimpio);
      const waMessageId = respuestaWA?.messages?.[0]?.id || null;
      memory.setUltimoEstadoEnvio(numeroLimpio, 'enviado', waMessageId);
    } catch (e) {
      console.error(`[wa] Error enviando mensaje a ${numeroLimpio}:`, e.message);
      memory.setUltimoEstadoEnvio(numeroLimpio, 'fallido');
    }
  }

  // Procesar trigger principal (excluye CONSENT_GRANTED que ya fue manejado arriba)
  if (trigger && trigger !== 'CONSENT_GRANTED') {
    const estadoActual = memory.get(numeroLimpio);

    // Detectar flujo desde el trigger para extraer datos correctamente
    // (ojo: HABLAR_ASESOR va antes que ASESOR porque también contiene "ASESOR")
    const flujoDelTrigger =
      trigger.includes('PROPIETARIO') ? 'propietario' :
      trigger.includes('HABLAR_ASESOR') ? 'hablar_asesor' :
      trigger.includes('ASESOR') ? 'asesor' :
      trigger.includes('COMPRADOR') ? 'comprador' :
      trigger.includes('ARRENDATARIO') ? 'arrendatario' : null;

    let datosExtraidos = estadoActual.datos || {};
    if (flujoDelTrigger) {
      stats.logEvent(`flujo_${flujoDelTrigger}`, numeroLimpio);
      const historialActual = estadoActual.historial.filter(m => m.role === 'user' || m.role === 'assistant');
      const extraidos = await extraerDatos(historialActual, flujoDelTrigger);
      datosExtraidos = { ...datosExtraidos, ...extraidos };
      memory.set(numeroLimpio, { flujo: flujoDelTrigger, datos: datosExtraidos });
    }

    await handleTrigger(trigger, numeroLimpio, datosExtraidos);
  }
}

const CATEGORIA_LABELS = {
  atendidos: 'Leads atendidos',
  fichas: 'Fichas enviadas',
  derivados: 'Leads derivados',
  fuera_horario: 'Fuera de horario',
  reactivados: 'Leads reactivados',
  flujo_propietario: 'Propietarios',
  flujo_asesor: 'Prospectos asesor',
  flujo_comprador: 'Compradores',
  flujo_arrendatario: 'Arrendatarios',
};

function statsDetalleHref(categoria, fechaFiltro) {
  return `/stats/detalle?tipo=${categoria}${fechaFiltro ? '&fecha=' + fechaFiltro : ''}`;
}

function diaCorto(fechaStr) {
  const [y, m, d] = fechaStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-EC', { weekday: 'short' }).replace('.', '');
}

function renderGraficoTendencia(serie) {
  const maxCantidad = Math.max(1, ...serie.map((d) => d.cantidad));
  const barras = serie.map((d) => {
    const pct = d.cantidad > 0 ? Math.max(Math.round((d.cantidad / maxCantidad) * 100), 4) : 0;
    return `<div title="${d.fecha}: ${d.cantidad} lead${d.cantidad === 1 ? '' : 's'}" style="flex:1;background:#0b3d2e;border-radius:3px 3px 0 0;height:${pct}%;"></div>`;
  }).join('');
  const labels = serie.map((d) => `<div style="flex:1;text-align:center;font-size:9px;color:#999;">${diaCorto(d.fecha)}</div>`).join('');
  return `
    <div style="display:flex;align-items:flex-end;gap:3px;height:90px;border-bottom:1px solid #eee;">${barras}</div>
    <div style="display:flex;gap:3px;margin-top:4px;">${labels}</div>`;
}

function renderComparacionPeriodo(cp) {
  let flecha = '→', color = '#666', texto = 'sin datos';
  if (cp.cambioPorcentual !== null) {
    texto = `${Math.abs(cp.cambioPorcentual)}%`;
    if (cp.cambioPorcentual > 0) { flecha = '↑'; color = '#15803d'; }
    else if (cp.cambioPorcentual < 0) { flecha = '↓'; color = '#b91c1c'; }
  }
  return `
    <div style="background:#f3f4f6;border-radius:12px;padding:16px 20px;margin-top:16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <div>
        <div style="font-size:12px;color:#666;">Últimos 7 días</div>
        <div style="font-size:24px;font-weight:800;color:#0b3d2e;">${cp.actual} leads</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:12px;color:#666;">vs. 7 días anteriores (${cp.anterior})</div>
        <div style="font-size:20px;font-weight:800;color:${color};">${flecha} ${texto}</div>
      </div>
    </div>`;
}

function renderStatsPage(fechaFiltro) {
  const s = stats.getStats(fechaFiltro);
  const desde = new Date(s.instaladoDesde).toLocaleDateString('es-EC');
  const actualizado = new Date().toLocaleString('es-EC');

  const box = (valor, label, categoria) => {
    const contenido = `
      <div style="background:#f3f4f6;border-radius:12px;padding:24px;text-align:center;">
        <div style="font-size:32px;font-weight:800;color:#0b3d2e;">${valor}</div>
        <div style="color:#555;margin-top:4px;">${label}</div>
      </div>`;
    if (!categoria) return contenido;
    return `<a href="${statsDetalleHref(categoria, fechaFiltro)}" style="text-decoration:none;display:block;">${contenido}</a>`;
  };
  const boxPct = (valor, label, categoria) => box(valor === null ? '–' : `${valor}%`, label, categoria);

  const flujoLabels = {
    propietario: 'Propietarios',
    asesor: 'Prospectos asesor',
    comprador: 'Compradores',
    arrendatario: 'Arrendatarios',
  };
  const filasFlujo = Object.entries(s.porFlujo)
    .map(([flujo, cantidad]) => `<tr><td style="padding:4px 12px;"><a href="${statsDetalleHref('flujo_' + flujo, fechaFiltro)}" style="color:#0b3d2e;text-decoration:none;">${flujoLabels[flujo] || flujo}</a></td><td style="padding:4px 12px;text-align:right;font-weight:700;">${cantidad}</td></tr>`)
    .join('');

  const CIUDAD_ORDEN = ['Manta', 'Portoviejo', 'Fuera de cobertura', 'Sin especificar'];
  const filasCiudad = CIUDAD_ORDEN
    .map((c) => `<tr><td style="padding:4px 12px;">${c}</td><td style="padding:4px 12px;text-align:right;font-weight:700;">${s.desgloseCiudad[c] || 0}</td></tr>`)
    .join('');

  const filasOperacion = [
    ['Venta', s.desgloseOperacion.venta],
    ['Arriendo', s.desgloseOperacion.arriendo],
    ['Compra', s.desgloseOperacion.compra],
    ['Alquiler', s.desgloseOperacion.alquiler],
  ].map(([label, cantidad]) => `<tr><td style="padding:4px 12px;">${label}</td><td style="padding:4px 12px;text-align:right;font-weight:700;">${cantidad}</td></tr>`).join('');

  return `
    <html>
      <head>
        <meta http-equiv="refresh" content="60">
        <meta charset="utf-8">
      </head>
      <body style="background:#0b3d2e;min-height:100vh;margin:0;display:flex;justify-content:center;align-items:flex-start;padding:40px 16px;font-family:sans-serif;">
        <div style="background:white;border-radius:20px;padding:32px;max-width:680px;width:100%;">
          <a href="/conversaciones" style="color:#0b3d2e;font-size:13px;font-weight:600;text-decoration:none;">← Volver al CRM</a>
          <h2 style="margin:8px 0 0;color:#0b3d2e;">💎 REMAX Diamond — Diamantito</h2>
          <p style="color:#666;margin-top:4px;">Estadísticas del agente desde ${desde}</p>

          <form method="GET" action="/stats" style="margin:16px 0;display:flex;gap:8px;align-items:center;">
            <input type="date" name="fecha" value="${fechaFiltro || ''}" style="padding:6px 10px;border-radius:8px;border:1px solid #ccc;">
            <button type="submit" style="padding:6px 14px;border-radius:8px;border:none;background:#0b3d2e;color:white;cursor:pointer;">Filtrar</button>
            <a href="/stats" style="color:#0b3d2e;text-decoration:underline;">Ver todo</a>
          </form>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:8px;">
            ${box(s.leadsAtendidos, 'Leads atendidos', 'atendidos')}
            ${box(s.fichasEnviadas, 'Fichas enviadas', 'fichas')}
            ${box(s.leadsDerivados, 'Leads derivados', 'derivados')}
            ${box(s.fueraHorario, 'Fuera de horario', 'fuera_horario')}
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-top:16px;">
            ${boxPct(s.tasaCalificacion, 'Tasa de calificación', 'derivados')}
            ${boxPct(s.tasaLectura, 'Tasa de lectura')}
            ${boxPct(s.tasaReactivacion, 'Tasa de reactivación', 'reactivados')}
          </div>

          ${renderComparacionPeriodo(s.comparacionPeriodo)}

          <h3 style="color:#0b3d2e;margin-top:28px;margin-bottom:12px;">Tendencia — últimos 14 días</h3>
          ${renderGraficoTendencia(s.serieTendencia)}

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:28px;">
            <div>
              <h3 style="color:#0b3d2e;margin:0 0 8px;">Por ciudad</h3>
              <table style="width:100%;border-collapse:collapse;">${filasCiudad}</table>
            </div>
            <div>
              <h3 style="color:#0b3d2e;margin:0 0 8px;">Por operación</h3>
              <table style="width:100%;border-collapse:collapse;">${filasOperacion}</table>
            </div>
          </div>

          <h3 style="color:#0b3d2e;margin-top:28px;">Desglose por tipo de lead</h3>
          <table style="width:100%;border-collapse:collapse;">${filasFlujo}</table>

          <hr style="margin-top:24px;border:none;border-top:1px solid #eee;">
          <p style="color:#999;font-size:13px;text-align:center;">Actualizado: ${actualizado} · Se refresca cada 60s</p>
        </div>
      </body>
    </html>
  `;
}

const HANDOFF_LABELS = {
  handoff_propietario: 'Propietario',
  handoff_asesor: 'Prospecto asesor',
  handoff_comprador: 'Comprador',
  handoff_arrendatario: 'Arrendatario',
  handoff_general: 'Consulta general',
  handoff_hablar_asesor: 'Quiere hablar con un asesor',
};

// Detalle de una categoría de /stats: lista de leads con nombre, número,
// fecha, y — para "derivados" — a qué asesor quedó asignado cada uno.
function renderDetalleCategoria(categoria, fechaFiltro) {
  const eventos = stats.listarPorCategoria(categoria, fechaFiltro);
  const todos = memory.getAll();
  const titulo = CATEGORIA_LABELS[categoria] || 'Leads';

  const filas = eventos.map((e) => {
    const estado = todos[e.numero] || {};
    const nombre = estado.datos?.nombre || e.numero;
    const fecha = new Date(e.fecha).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' });
    const asesor = estado.datos?.asesorAsignado?.nombre;
    const detalle = categoria === 'derivados'
      ? (asesor ? `👤 ${asesor}` : (HANDOFF_LABELS[e.tipo] || e.tipo))
      : (HANDOFF_LABELS[e.tipo] || motivoConsulta(estado));
    return `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #eee;">
          <a href="/conversaciones?numero=${encodeURIComponent(e.numero)}&columna=todos" style="color:#0b3d2e;text-decoration:none;font-weight:700;font-size:14px;">${nombre}</a>
          <div style="font-size:11px;color:#999;margin-top:2px;">${e.numero} · ${detalle}</div>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:right;color:#666;font-size:12px;white-space:nowrap;">${fecha}</td>
      </tr>`;
  }).join('');

  return `
    <html>
      <head>
        <meta charset="utf-8">
      </head>
      <body style="background:#0b3d2e;min-height:100vh;margin:0;display:flex;justify-content:center;align-items:flex-start;padding:40px 16px;font-family:sans-serif;">
        <div style="background:white;border-radius:20px;padding:32px;max-width:600px;width:100%;">
          <a href="/stats${fechaFiltro ? '?fecha=' + fechaFiltro : ''}" style="color:#0b3d2e;font-size:13px;font-weight:600;text-decoration:none;">← Volver a Stats</a>
          <h2 style="margin:8px 0 0;color:#0b3d2e;">${titulo}</h2>
          <p style="color:#666;margin-top:4px;">${eventos.length} lead${eventos.length === 1 ? '' : 's'}</p>

          <table style="width:100%;border-collapse:collapse;margin-top:12px;">
            ${filas || '<tr><td style="padding:16px 12px;color:#999;">Sin datos para esta categoría.</td></tr>'}
          </table>
        </div>
      </body>
    </html>
  `;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function renderPrivacyPage() {
  return `
    <html>
      <head>
        <meta charset="utf-8">
        <title>Política de Privacidad — RE/MAX Diamond</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
      </head>
      <body style="font-family:sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#222;">
        <h1 style="color:#0b3d2e;">Política de Privacidad</h1>
        <p><strong>RE/MAX Diamond</strong></p>
        <p>Última actualización: ${new Date().toLocaleDateString('es-EC')}</p>

        <h2>1. Responsable del tratamiento</h2>
        <p>RE/MAX Diamond, con domicilio en Av. Flavio Reyes entre Av. 24 y Calle 23, CC Manta Shopping Maincentro, Local 26, Manta, Manabí, Ecuador, es responsable del tratamiento de los datos personales que usted nos proporciona a través de nuestro asistente virtual de WhatsApp ("Diamantito") y demás canales de contacto.</p>

        <h2>2. Datos que recolectamos</h2>
        <p>Según el motivo de su contacto, podemos solicitar: nombre completo, número de teléfono, ciudad o sector, tipo y características de la propiedad de interés (venta, arriendo, compra o renta), presupuesto, disponibilidad de contacto, fecha de cumpleaños (opcional) y, en caso de postulación como asesor, información sobre su experiencia y situación laboral.</p>

        <h2>3. Finalidad</h2>
        <p>Utilizamos estos datos exclusivamente para: contactarlo con un asesor inmobiliario, dar seguimiento a su consulta, evaluar postulaciones para unirse a nuestro equipo de asesores, y mejorar nuestro servicio de atención.</p>

        <h2>4. Base legal</h2>
        <p>El tratamiento de sus datos se realiza conforme a la <a href="https://www.telecomunicaciones.gob.ec/ley-y-reglamento-de-la-ley-de-proteccion-de-datos-personales/">Ley Orgánica de Protección de Datos Personales del Ecuador</a>, en particular en virtud del Art. 7 numeral 5 (ejecución de medidas precontractuales a petición del titular). El aviso correspondiente se le presenta antes de solicitar cualquier dato personal, y el hecho de continuar la conversación constituye su consentimiento implícito.</p>

        <h2>5. Conservación de datos</h2>
        <p>Conservamos sus datos durante el tiempo necesario para gestionar su consulta y dar cumplimiento a obligaciones legales o contractuales aplicables.</p>

        <h2>6. Sus derechos</h2>
        <p>Usted tiene derecho a acceder, rectificar, actualizar o solicitar la eliminación de sus datos personales. Para ejercer estos derechos, puede contactarnos a través de los canales oficiales de RE/MAX Diamond.</p>

        <h2>7. Compartición de datos</h2>
        <p>Sus datos son compartidos únicamente con el asesor inmobiliario o responsable de selección correspondiente dentro de RE/MAX Diamond, con el fin de darle seguimiento a su consulta. No vendemos ni cedemos sus datos a terceros ajenos a la operación de la empresa.</p>

        <h2>8. Contacto</h2>
        <p>Para consultas sobre esta política o sobre el tratamiento de sus datos, puede escribirnos a través de nuestro sitio web <a href="https://www.remax.com.ec/diamond">remax.com.ec/diamond</a> o al correo <a href="mailto:diamond@remax.com.ec">diamond@remax.com.ec</a>.</p>
      </body>
    </html>
  `;
}

function checkAuth(req, res) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return true; // sin contraseña configurada, no se protege (no recomendado)

  const header = req.headers.authorization || '';
  const [, encoded] = header.split(' ');
  const decoded = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
  const [, pass] = decoded.split(':');

  if (pass === password) return true;

  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="RE/MAX Diamond"' });
  res.end('Acceso restringido');
  return false;
}

function tiempoRelativo(fechaIso) {
  if (!fechaIso) return '-';
  const diffMs = Date.now() - new Date(fechaIso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const horas = Math.floor(min / 60);
  if (horas < 24) return `hace ${horas}h`;
  const dias = Math.floor(horas / 24);
  if (dias === 1) return 'ayer';
  return `hace ${dias}d`;
}

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
    case 'hablar_asesor':
      return 'Quiere hablar con un asesor';
    default:
      return 'Sin clasificar';
  }
}

// Columna del Kanban: nuevos (todavía conversando) → calificados (terminó el
// flujo). La tarjeta ya muestra el asesor asignado cuando corresponde, no
// hace falta una columna aparte para eso.
function columnaLead(estado) {
  if (!estado.datos?.handoffListo) return 'nuevos';
  return 'calificados';
}

function sinRespuesta(estado) {
  if (!estado.ultimoMensaje) return false;
  const horas = (Date.now() - new Date(estado.ultimoMensaje).getTime()) / 1000 / 60 / 60;
  return horas > 24 && !estado.datos?.handoffListo;
}

function csvEscape(valor) {
  const texto = String(valor ?? '');
  return /[",\n]/.test(texto) ? '"' + texto.replace(/"/g, '""') + '"' : texto;
}

// Exporta todos los leads (no las derivaciones internas) a CSV para trabajar
// fuera del dashboard — no respeta los filtros del buscador (esos corren solo
// en el navegador), exporta siempre la lista completa.
function generarCSVLeads() {
  const todos = memory.getAll();
  const reclutamientoNumero = process.env.WHATSAPP_RECLUTAMIENTO || '';
  const columnas = ['Nombre', 'Numero', 'Flujo', 'Motivo', 'Sector', 'Operacion', 'Presupuesto', 'Estado', 'Asesor asignado', 'Prioridad', 'Nota', 'Ultimo mensaje'];
  const filas = [columnas.join(',')];

  for (const [numero, estado] of Object.entries(todos)) {
    if (estado.esGuardia || numero === reclutamientoNumero) continue;
    if (!estado.historial || estado.historial.length === 0) continue;
    const fila = [
      estado.datos?.nombre || '',
      numero,
      estado.flujo || '',
      motivoConsulta(estado),
      estado.datos?.sector || '',
      estado.datos?.operacion || '',
      estado.datos?.presupuesto || estado.datos?.precio || '',
      columnaLead(estado) === 'nuevos' ? 'Nuevo' : 'Calificado',
      estado.datos?.asesorAsignado?.nombre || '',
      estado.prioridad || '',
      estado.nota || '',
      estado.ultimoMensaje ? new Date(estado.ultimoMensaje).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' }) : '',
    ].map(csvEscape);
    filas.push(fila.join(','));
  }

  return filas.join('\n');
}

const COLUMNAS = [
  { key: 'nuevos', label: 'Nuevos', color: '#1d4ed8', bg: '#dbeafe' },
  { key: 'calificados', label: 'Calificados', color: '#b45309', bg: '#fef3c7' },
];

// Normaliza la operación de un lead a un valor de filtro simple.
function operacionFiltro(estado) {
  const op = (estado.datos?.operacion || '').toLowerCase();
  switch (estado.flujo) {
    case 'propietario':
      if (op.includes('arriendo')) return 'arriendo';
      if (op.includes('venta')) return 'venta';
      return '';
    case 'comprador': return 'compra';
    case 'arrendatario': return 'alquiler';
    default: return '';
  }
}

function prioridadBadge(estado) {
  if (estado.prioridad === 'urgente') {
    return `<span style="display:inline-block;margin-top:6px;margin-right:4px;background:#fee2e2;color:#b91c1c;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;">🔴 Urgente</span>`;
  }
  if (estado.prioridad === 'descartado') {
    return `<span style="display:inline-block;margin-top:6px;margin-right:4px;background:#f1f1f1;color:#888;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;">⚪ Descartado</span>`;
  }
  return '';
}

function renderTarjeta(numero, estado, numeroSeleccionado, miColumna) {
  const nombre = estado.datos?.nombre || numero;
  const motivo = motivoConsulta(estado);
  const fecha = tiempoRelativo(estado.ultimoMensaje);
  const activo = numero === numeroSeleccionado;
  const asignado = estado.datos?.asesorAsignado;
  const sinResp = sinRespuesta(estado);
  const notaTexto = estado.nota || estado.notaAutomatica || '';
  return `
    <a href="/conversaciones?numero=${encodeURIComponent(numero)}&columna=${encodeURIComponent(miColumna)}"
       class="tarjeta-lead"
       data-nombre="${nombre.toLowerCase()}"
       data-numero="${numero}"
       data-sector="${(estado.datos?.sector || '').toLowerCase()}"
       data-operacion="${operacionFiltro(estado)}"
       data-sinrespuesta="${sinResp ? '1' : '0'}"
       style="text-decoration:none;color:inherit;display:block;margin-bottom:8px;">
      <div style="background:white;border:1px solid ${activo ? '#0b3d2e' : '#e5e7eb'};${activo ? 'box-shadow:0 0 0 2px #0b3d2e33;' : ''}border-radius:10px;padding:10px 12px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;">
          <div style="font-weight:700;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${nombre}</div>
          <div style="font-size:11px;color:#999;flex-shrink:0;">${fecha}</div>
        </div>
        <div style="font-size:12px;color:#666;margin-top:2px;">${motivo}</div>
        ${asignado && asignado.nombre !== 'Backup oficina' ? `<div style="font-size:11px;color:#0b3d2e;margin-top:4px;">👤 ${asignado.nombre}</div>` : ''}
        ${sinResp ? `<span style="display:inline-block;margin-top:6px;background:#f1f1f1;color:#666;font-size:10px;font-weight:600;padding:2px 8px;border-radius:999px;">Sin respuesta</span>` : ''}
        ${prioridadBadge(estado)}
        ${notaTexto ? `<div style="font-size:11px;color:#555;margin-top:4px;font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📝 ${notaTexto}</div>` : ''}
      </div>
    </a>`;
}

// Ícono de estado de entrega (solo aplica a mensajes que le mandamos al lead).
function iconoEstadoEnvio(estadoEnvio) {
  switch (estadoEnvio) {
    case 'leido': return '<span style="color:#53bdeb;">✓✓</span>';
    case 'entregado': return '<span style="opacity:0.7;">✓✓</span>';
    case 'enviado': return '<span style="opacity:0.7;">✓</span>';
    case 'fallido': return '<span style="color:#f87171;">⚠ no enviado</span>';
    default: return '';
  }
}

function renderBurbujas(historial) {
  return (historial || []).map((m) => {
    const esUsuario = m.role === 'user';
    const hora = m.ts
      ? new Date(m.ts).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Guayaquil' })
      : '';
    const icono = !esUsuario ? iconoEstadoEnvio(m.estadoEnvio) : '';
    return `
      <div style="display:flex;justify-content:${esUsuario ? 'flex-start' : 'flex-end'};margin:6px 0;">
        <div style="max-width:85%;padding:8px 11px;border-radius:12px;font-size:12px;background:${esUsuario ? '#f0f0f0' : '#0b3d2e'};color:${esUsuario ? '#222' : 'white'};">
          ${m.content.replace(/\n/g, '<br>')}
          ${hora || icono ? `<div style="font-size:9px;opacity:0.85;margin-top:4px;text-align:right;">${hora}${icono ? ' ' + icono : ''}</div>` : ''}
        </div>
      </div>`;
  }).join('');
}

function botonPrioridad(numero, miColumna, valor, label, activo, colorActivo) {
  return `
    <form method="POST" action="/conversaciones/prioridad" style="margin:0;">
      <input type="hidden" name="numero" value="${numero}">
      <input type="hidden" name="columna" value="${miColumna}">
      <input type="hidden" name="prioridad" value="${valor}">
      <button type="submit" style="font-size:11px;padding:4px 8px;border-radius:6px;border:1px solid ${activo ? colorActivo : '#ddd'};background:${activo ? colorActivo + '22' : 'white'};color:${activo ? colorActivo : '#555'};cursor:pointer;white-space:nowrap;">${label}</button>
    </form>`;
}

// Chat de un lead/hilo, pensado para reemplazar la lista DENTRO de su misma
// columna (no como panel aparte) — con un botón para volver a la lista, y
// abajo las notas internas / prioridad manual (no aplica a hilos internos).
function renderChatEnColumna(numero, estado, reclutamientoNumero, miColumna) {
  const titulo = numero === reclutamientoNumero
    ? 'Reclutamiento / oficina'
    : estado.esGuardia ? `Asesor — ${estado.nombreGuardia || numero}`
    : (estado.datos?.nombre || numero);
  const subtitulo = numero === reclutamientoNumero
    ? 'Resúmenes enviados'
    : estado.esGuardia ? 'Leads derivados'
    : 'Flujo: ' + (estado.flujo || '-');
  const esLead = numero !== reclutamientoNumero && !estado.esGuardia;

  const seccionNotas = !esLead ? '' : `
    <div style="padding:10px 12px 12px;border-top:1px solid #eee;">
      ${estado.notaAutomatica ? `<div style="font-size:11px;color:#7c3aed;background:#f5f3ff;padding:6px 8px;border-radius:6px;margin-bottom:8px;">${estado.notaAutomatica}</div>` : ''}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
        ${botonPrioridad(numero, miColumna, 'urgente', '🔴 Urgente', estado.prioridad === 'urgente', '#b91c1c')}
        ${botonPrioridad(numero, miColumna, 'descartado', '⚪ Descartado', estado.prioridad === 'descartado', '#666')}
        ${estado.prioridad ? botonPrioridad(numero, miColumna, '', 'Quitar', false, '#999') : ''}
      </div>
      <form method="POST" action="/conversaciones/nota">
        <input type="hidden" name="numero" value="${numero}">
        <input type="hidden" name="columna" value="${miColumna}">
        <label style="font-size:11px;font-weight:700;color:#555;">📝 Nota interna</label>
        <textarea name="nota" rows="2" placeholder="Ej: en seguimiento, no contesta..."
          style="width:100%;box-sizing:border-box;font-size:12px;padding:6px;border-radius:6px;border:1px solid #ddd;margin-top:4px;resize:vertical;font-family:inherit;">${estado.nota || ''}</textarea>
        <button type="submit" style="margin-top:6px;font-size:11px;padding:5px 12px;border-radius:6px;border:none;background:#0b3d2e;color:white;cursor:pointer;">Guardar nota</button>
      </form>
    </div>`;

  return `
    <a href="/conversaciones" style="text-decoration:none;display:inline-flex;align-items:center;gap:4px;color:#0b3d2e;font-size:12px;font-weight:600;padding:8px 10px;">
      ← Volver
    </a>
    <div style="padding:0 12px 10px;">
      <div style="font-weight:700;font-size:13px;">${titulo}</div>
      <div style="color:#666;font-size:11px;margin-bottom:8px;">${numero} · ${subtitulo}</div>
      <div>${renderBurbujas(estado.historial)}</div>
    </div>
    ${seccionNotas}`;
}

// Cuerpo de una columna: si el lead seleccionado fue clickeado DESDE esta
// misma columna (columnaSeleccionada === miColumna), muestra su chat en vez
// de la lista de tarjetas. Así el chat solo aparece en la columna donde se
// hizo click, no en todas las columnas donde ese lead también aparece.
function renderCuerpoColumna(items, numeroSeleccionado, columnaSeleccionada, miColumna, reclutamientoNumero, tarjetaFn, vacioTexto) {
  const seleccionado = columnaSeleccionada === miColumna
    ? items.find(([numero]) => numero === numeroSeleccionado)
    : null;
  if (seleccionado) {
    const [numero, estado] = seleccionado;
    return renderChatEnColumna(numero, estado, reclutamientoNumero, miColumna);
  }
  return `<div style="padding:10px;">${
    items.map(([numero, estado]) => tarjetaFn(numero, estado, numeroSeleccionado, miColumna)).join('') || `<p style="color:#999;font-size:12px;padding:8px;">${vacioTexto}</p>`
  }</div>`;
}

function renderTarjetaInterna(numero, estado, numeroSeleccionado, miColumna) {
  const nombre = numero === (process.env.WHATSAPP_RECLUTAMIENTO || '')
    ? '📋 Reclutamiento / oficina'
    : `🔔 Asesor — ${estado.nombreGuardia || numero}`;
  const fecha = tiempoRelativo(estado.ultimoMensaje);
  const activo = numero === numeroSeleccionado;
  return `
    <a href="/conversaciones?numero=${encodeURIComponent(numero)}&columna=${encodeURIComponent(miColumna)}"
       class="tarjeta-lead"
       data-nombre="${nombre.toLowerCase()}"
       data-numero="${numero}"
       style="text-decoration:none;color:inherit;display:block;margin-bottom:8px;">
      <div style="background:white;border:1px solid ${activo ? '#0b3d2e' : '#e5e7eb'};${activo ? 'box-shadow:0 0 0 2px #0b3d2e33;' : ''}border-radius:10px;padding:10px 12px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;">
          <div style="font-weight:700;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${nombre}</div>
          <div style="font-size:11px;color:#999;flex-shrink:0;">${fecha}</div>
        </div>
      </div>
    </a>`;
}

function renderConversacionesPage(numeroSeleccionado, columnaSeleccionada) {
  const todas = memory.getAll();
  const reclutamientoNumero = process.env.WHATSAPP_RECLUTAMIENTO || '';

  const todasEntradas = Object.entries(todas)
    .filter(([, estado]) => estado.historial && estado.historial.length > 0)
    .sort(([, a], [, b]) => new Date(b.ultimoMensaje || 0) - new Date(a.ultimoMensaje || 0));

  // Separar leads reales de los hilos internos (asesores/oficina) — esos van aparte, no son leads.
  const leads = todasEntradas.filter(([numero, estado]) => numero !== reclutamientoNumero && !estado.esGuardia);
  const internas = todasEntradas.filter(([numero, estado]) => numero === reclutamientoNumero || estado.esGuardia);

  const porColumna = { nuevos: [], calificados: [] };
  for (const [numero, estado] of leads) {
    porColumna[columnaLead(estado)].push([numero, estado]);
  }

  const columnaTodosHtml = `
    <div class="columna-kanban" style="min-width:260px;flex:1;display:flex;flex-direction:column;background:#f8f9fa;border-radius:12px;overflow:hidden;">
      <div style="padding:12px 14px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;">
        <span style="font-weight:700;color:#0b3d2e;">Todos</span>
        <span style="background:#0b3d2e;color:white;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;">${leads.length}</span>
      </div>
      <div style="overflow-y:auto;max-height:65vh;">
        ${renderCuerpoColumna(leads, numeroSeleccionado, columnaSeleccionada, 'todos', reclutamientoNumero, renderTarjeta, 'Sin leads todavía.')}
      </div>
    </div>`;

  const columnasHtml = COLUMNAS.map((col) => {
    const items = porColumna[col.key];
    return `
      <div class="columna-kanban" style="min-width:260px;flex:1;display:flex;flex-direction:column;background:#f8f9fa;border-radius:12px;overflow:hidden;">
        <div style="padding:12px 14px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;">
          <span style="font-weight:700;color:${col.color};">${col.label}</span>
          <span style="background:${col.bg};color:${col.color};font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;">${items.length}</span>
        </div>
        <div style="overflow-y:auto;max-height:65vh;">
          ${renderCuerpoColumna(items, numeroSeleccionado, columnaSeleccionada, col.key, reclutamientoNumero, renderTarjeta, 'Sin leads acá.')}
        </div>
      </div>`;
  }).join('');

  const columnaInternasHtml = `
    <div class="columna-kanban" style="min-width:260px;flex:1;display:flex;flex-direction:column;background:#f8f9fa;border-radius:12px;overflow:hidden;">
      <div style="padding:12px 14px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;">
        <span style="font-weight:700;color:#666;">Derivaciones</span>
        <span style="background:#e5e7eb;color:#666;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;">${internas.length}</span>
      </div>
      <div style="overflow-y:auto;max-height:65vh;">
        ${renderCuerpoColumna(internas, numeroSeleccionado, columnaSeleccionada, 'derivaciones', reclutamientoNumero, renderTarjetaInterna, 'Sin derivaciones todavía.')}
      </div>
    </div>`;

  return `
    <html>
      <head>
        <meta charset="utf-8">
      </head>
      <body style="background:#0b3d2e;min-height:100vh;margin:0;padding:24px;font-family:sans-serif;">
        <div style="max-width:1300px;margin:0 auto;">
          <div style="background:white;border-radius:16px;padding:20px;">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px;">
              <div style="display:flex;align-items:center;gap:16px;">
                <h2 style="margin:0;color:#0b3d2e;">💎 CRM de Diamantito</h2>
                <a href="/stats" style="color:#0b3d2e;font-size:13px;font-weight:600;text-decoration:none;background:#eef6f2;padding:6px 12px;border-radius:8px;">📊 Stats</a>
                <a href="/conversaciones/exportar.csv" style="color:#0b3d2e;font-size:13px;font-weight:600;text-decoration:none;background:#eef6f2;padding:6px 12px;border-radius:8px;">⬇️ Exportar CSV</a>
              </div>
              <div style="position:relative;width:260px;">
                <input id="buscador" type="text" placeholder="Buscar nombre o número..."
                  style="width:100%;box-sizing:border-box;padding:8px 12px 8px 32px;border-radius:8px;border:1px solid #ddd;font-size:14px;">
                <span style="position:absolute;left:10px;top:8px;color:#999;">🔍</span>
              </div>
            </div>

            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px;">
              <input id="filtroSector" type="text" placeholder="Filtrar por sector..."
                style="padding:6px 10px;border-radius:8px;border:1px solid #ddd;font-size:12px;width:160px;">
              <select id="filtroOperacion" style="padding:6px 10px;border-radius:8px;border:1px solid #ddd;font-size:12px;">
                <option value="">Todas las operaciones</option>
                <option value="venta">Venta</option>
                <option value="arriendo">Arriendo</option>
                <option value="compra">Compra</option>
                <option value="alquiler">Alquiler</option>
              </select>
              <label style="font-size:12px;color:#555;display:flex;align-items:center;gap:4px;cursor:pointer;">
                <input id="filtroSinRespuesta" type="checkbox"> Sin respuesta
              </label>
              <a href="#" id="limpiarFiltros" style="font-size:12px;color:#999;text-decoration:underline;">Limpiar filtros</a>
            </div>

            <div style="display:flex;gap:12px;overflow-x:auto;padding-bottom:8px;">
              ${columnaTodosHtml}
              ${columnasHtml}
              ${columnaInternasHtml}
            </div>
          </div>
        </div>

        <script>
          const buscador = document.getElementById('buscador');
          const filtroSector = document.getElementById('filtroSector');
          const filtroOperacion = document.getElementById('filtroOperacion');
          const filtroSinRespuesta = document.getElementById('filtroSinRespuesta');
          const limpiarFiltros = document.getElementById('limpiarFiltros');
          const tarjetas = Array.from(document.querySelectorAll('.tarjeta-lead'));

          function aplicarFiltros() {
            const texto = buscador.value.trim().toLowerCase();
            const sector = filtroSector.value.trim().toLowerCase();
            const operacion = filtroOperacion.value;
            const soloSinRespuesta = filtroSinRespuesta.checked;

            tarjetas.forEach((t) => {
              const coincideTexto = !texto || t.dataset.nombre.includes(texto) || t.dataset.numero.includes(texto);
              const coincideSector = !sector || (t.dataset.sector || '').includes(sector);
              const coincideOperacion = !operacion || t.dataset.operacion === operacion;
              const coincideSinResp = !soloSinRespuesta || t.dataset.sinrespuesta === '1';
              const visible = coincideTexto && coincideSector && coincideOperacion && coincideSinResp;
              t.style.display = visible ? 'block' : 'none';
            });
          }

          [buscador, filtroSector].forEach((el) => el.addEventListener('input', aplicarFiltros));
          [filtroOperacion, filtroSinRespuesta].forEach((el) => el.addEventListener('change', aplicarFiltros));
          limpiarFiltros.addEventListener('click', (e) => {
            e.preventDefault();
            buscador.value = '';
            filtroSector.value = '';
            filtroOperacion.value = '';
            filtroSinRespuesta.checked = false;
            aplicarFiltros();
          });
        </script>
      </body>
    </html>
  `;
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, 'http://localhost');

    if (parsedUrl.pathname === '/conversaciones') {
      if (!checkAuth(req, res)) return;
      const numeroSeleccionado = parsedUrl.searchParams.get('numero');
      const columnaSeleccionada = parsedUrl.searchParams.get('columna');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderConversacionesPage(numeroSeleccionado, columnaSeleccionada));
      return;
    }

    if (parsedUrl.pathname === '/conversaciones/nota' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      const body = await readBody(req);
      const params = new URLSearchParams(body.toString('utf8'));
      const numero = params.get('numero');
      const columna = params.get('columna') || '';
      if (numero) memory.set(numero, { nota: (params.get('nota') || '').trim() });
      res.writeHead(302, { Location: `/conversaciones?numero=${encodeURIComponent(numero || '')}&columna=${encodeURIComponent(columna)}` });
      res.end();
      return;
    }

    if (parsedUrl.pathname === '/conversaciones/prioridad' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      const body = await readBody(req);
      const params = new URLSearchParams(body.toString('utf8'));
      const numero = params.get('numero');
      const columna = params.get('columna') || '';
      // Cualquier acción manual (incluso "quitar") queda marcada como manual,
      // para que Diamantito ya no pise esta decisión con el marcado automático.
      if (numero) memory.set(numero, { prioridad: params.get('prioridad') || null, prioridadManual: true });
      res.writeHead(302, { Location: `/conversaciones?numero=${encodeURIComponent(numero || '')}&columna=${encodeURIComponent(columna)}` });
      res.end();
      return;
    }

    if (parsedUrl.pathname === '/conversaciones/exportar.csv') {
      if (!checkAuth(req, res)) return;
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="leads_diamantito.csv"',
      });
      res.end('﻿' + generarCSVLeads());
      return;
    }

    if (parsedUrl.pathname === '/stats') {
      const fechaFiltro = parsedUrl.searchParams.get('fecha') || null;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderStatsPage(fechaFiltro));
      return;
    }

    if (parsedUrl.pathname === '/stats/detalle') {
      const categoria = parsedUrl.searchParams.get('tipo') || '';
      const fechaFiltro = parsedUrl.searchParams.get('fecha') || null;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDetalleCategoria(categoria, fechaFiltro));
      return;
    }

    // Verificación del webhook (Meta llama esto una vez al configurarlo)
    if (parsedUrl.pathname === '/webhook' && req.method === 'GET') {
      const mode = parsedUrl.searchParams.get('hub.mode');
      const tokenRecibido = parsedUrl.searchParams.get('hub.verify_token');
      const challenge = parsedUrl.searchParams.get('hub.challenge');

      if (mode === 'subscribe' && tokenRecibido === VERIFY_TOKEN) {
        console.log('[webhook] Verificación de Meta exitosa');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(challenge);
      } else {
        console.log('[webhook] Verificación fallida — token no coincide');
        res.writeHead(403);
        res.end('Forbidden');
      }
      return;
    }

    // Mensajes entrantes
    if (parsedUrl.pathname === '/webhook' && req.method === 'POST') {
      const rawBody = await readBody(req);
      const firma = req.headers['x-hub-signature-256'];

      if (!whatsapp.verifySignature(rawBody, firma)) {
        console.error('[webhook] Firma inválida — mensaje rechazado');
        res.writeHead(403);
        res.end('Invalid signature');
        return;
      }

      // Responder rápido a Meta; el procesamiento sigue en segundo plano
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');

      let payload;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch (e) {
        console.error('[webhook] Error parseando payload:', e.message);
        return;
      }

      for (const entry of payload.entry || []) {
        for (const change of entry.changes || []) {
          const mensajes = change.value?.messages || [];
          for (const msg of mensajes) {
            if (msg.type !== 'text') continue;
            const numeroLimpio = msg.from;
            const texto = msg.text?.body || '';
            if (!texto) continue;

            procesarMensaje(numeroLimpio, texto).catch((e) =>
              console.error('[webhook] Error procesando mensaje:', e.message),
            );
          }

          // Estados de entrega/lectura de los mensajes que le mandamos al lead
          // (enviado → entregado → leído), para mostrarlos en el dashboard.
          const ESTADOS_WA = { sent: 'enviado', delivered: 'entregado', read: 'leido', failed: 'fallido' };
          const statuses = change.value?.statuses || [];
          for (const st of statuses) {
            const estado = ESTADOS_WA[st.status];
            if (estado && st.id) memory.setMessageStatus(st.id, estado);
          }
        }
      }
      return;
    }

    if (parsedUrl.pathname === '/privacidad') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderPrivacyPage());
      return;
    }

    if (parsedUrl.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Diamantito está activo ✅');
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`[server] Escuchando en puerto ${PORT}`));
}

scheduler.init();
startServer();
