// Ficha de una propiedad pautada en formato WhatsApp, armada en código con los
// datos de la publicación (data/propiedades_pautadas.json → "ficha"), para que
// los números salgan exactos y el lead no tenga que salir del chat.
const fmt = (n) => Number(n).toLocaleString('es-EC', { maximumFractionDigits: 2 });
// Cantidades enteras (dormitorios, baños, parqueaderos) y montos con decimales ("USD 375.78").
const entero = (s) => { const m = String(s || '').match(/\d+/); return m ? Number(m[0]) : null; };
const monto = (s) => { const m = String(s || '').match(/\d+(\.\d+)?/); return m ? Number(m[0]) : null; };

// "Avenida Malecón S/N, Manta, Manta, Manabí" → "Avenida Malecón, Manta, Manabí".
// Si la publicación no trae una dirección útil, se usa "ubicacion" (cargada a mano)
// o la descripción de la lista.
function ubicacion(p) {
  if (p.ubicacion) return p.ubicacion;
  const f = p.ficha || {};
  const partes = String(f.direccion || '').split(',')
    .map((s) => s.replace(/\bS\/N\b/gi, '').replace(/\s+\d+\s+0$/, '').trim())
    .filter(Boolean);
  const unicas = partes.filter((s, i) => partes.findIndex((x) => x.toLowerCase() === s.toLowerCase()) === i);
  const inutil = !unicas.length || /desconocida|^s\/?n$/i.test(unicas[0]);
  return inutil ? p.descripcion : unicas.join(', ');
}

function destacados(datos) {
  const lista = ['características', 'amenities', 'servicios']
    .flatMap((k) => String(datos[k] || '').split(',').map((s) => s.trim()).filter(Boolean))
    .filter((s) => !/^acceso de parqueadero$/i.test(s));
  if (/s[ií]/i.test(datos['apto crédito'] || '')) lista.unshift('Apto crédito');
  if (/s[ií]/i.test(datos['ofrece financiamiento'] || '')) lista.unshift('Ofrece financiamiento');
  return [...new Set(lista)].slice(0, 4);
}

// Devuelve el texto de la ficha, o null si no hay datos de la publicación.
function textoFicha(p, { conPrecio }) {
  const f = p.ficha;
  if (!f) return null;
  const d = f.datos || {};
  const alquiler = /alquiler/i.test(p.operacion || '');
  const lineas = [`🏠 *${p.tipo} en ${alquiler ? 'alquiler' : 'venta'}*`, `📍 ${ubicacion(p)}`];

  if (conPrecio && f.precio) {
    const expensas = monto(d.expensas);
    lineas.push(`💰 ${f.moneda || 'USD'} ${fmt(f.precio)}${alquiler ? ' mensuales' : ''}${expensas ? ` (+ USD ${fmt(expensas)} de alícuota)` : ''}`);
  }

  const m2 = [];
  if (d['superficie total']) m2.push(`${d['superficie total']} totales`);
  if (d['superficie cubierta'] && d['superficie cubierta'] !== d['superficie total']) m2.push(`${d['superficie cubierta']} de construcción`);
  if (d['superficie terreno'] && d['superficie terreno'] !== d['superficie total']) m2.push(`${d['superficie terreno']} de terreno`);
  if (m2.length) lineas.push(`📐 ${m2.join(' · ')}`);

  const amb = [];
  const dorm = entero(d.dormitorios);
  const banos = entero(d['baños']);
  if (dorm) amb.push(`${dorm} ${dorm === 1 ? 'habitación' : 'habitaciones'}`);
  if (banos) amb.push(`${banos} ${banos === 1 ? 'baño' : 'baños'}${entero(d['medios baños']) ? ' + medio baño' : ''}`);
  if (amb.length) lineas.push(`🛏️ ${amb.join(' · ')}`);
  const parq = entero(d.parqueaderos);
  if (parq) lineas.push(`🚗 ${parq} ${parq === 1 ? 'parqueadero' : 'parqueaderos'}`);

  const extra = destacados(d);
  if (extra.length) lineas.push(`✨ ${extra.join(' · ')}`);
  return lineas.join('\n');
}

module.exports = { textoFicha, ubicacion };
