// Trae de remax.com.ec los datos de cada propiedad pautada (precio, ubicación,
// medidas, ambientes, descripción) y los guarda en data/propiedades_pautadas.json
// bajo "ficha", para que Diamantito pueda responder con datos reales.
//
//   node scripts/actualizar-pautadas.js
//
// Volver a correrlo cuando cambie una propiedad o se sume una pautada nueva.
const fs = require('fs');
const path = require('path');

const ARCHIVO = path.join(__dirname, '../data/propiedades_pautadas.json');

const decode = (s) => s
  .replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&nbsp;/g, ' ');
const limpiar = (s) => decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// Las publicaciones traen iniciales del asesor (ej. "J/T/G", "Y/T") al principio y al final.
const sinIniciales = (s) => s.replace(/^([A-Z]\/)+[A-Z]\s+/, '').replace(/\s+([A-Z]\/)+[A-Z]$/, '').trim();

function parsear(html) {
  const titulo = limpiar((html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/) || html.match(/<title>([^<]*)/) || [])[1]);
  const precio = Number((html.match(/itemprop="price">\s*([\d.]+)\s*</) || [])[1]) || null;
  const moneda = limpiar((html.match(/itemprop="priceCurrency">\s*(\w+)\s*</) || [])[1]) || 'USD';
  const descripcion = sinIniciales(limpiar((html.match(/id="last" class="title-description space">([\s\S]*?)<\/h3>/) || [])[1]));

  // Lista "clave: valor" de la ficha (entre "See more" y "Código de publicación").
  const lineas = decode(html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, '\n'))
    .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const ini = lineas.findIndex((l) => /^See more$/i.test(l));
  const fin = lineas.findIndex((l, i) => i > ini && /^Código de publicación/i.test(l));
  // Después de los datos sueltos vienen listas con título propio (Ambientes,
  // Características, Amenities, Servicios…), que se guardan como listas.
  const LISTAS = /^(Ambientes|Características|Amenities|Servicios|Adicionales|Comodidades)$/i;
  const datos = {};
  if (ini >= 0) {
    let clave = null;
    let enLista = false;
    for (const l of lineas.slice(ini + 1, fin > 0 ? fin : undefined)) {
      if (/^See more$/i.test(l)) continue;
      if (LISTAS.test(l)) { clave = l.toLowerCase(); datos[clave] = []; enLista = true; continue; }
      const m = l.match(/^([^:]+):\s*(.*)$/);
      if (m && !enLista) { clave = m[1].trim().toLowerCase(); datos[clave] = m[2].trim(); }
      else if (enLista) datos[clave].push(l);
      else if (clave) datos[clave] = `${datos[clave]} ${l}`.trim();
    }
    for (const [k, v] of Object.entries(datos)) if (Array.isArray(v)) datos[k] = v.join(', ');
  }
  const mls = ((html.match(/itemprop="productId">\s*([\w-]+)\s*</) || [])[1] || '').trim() || null;
  const corte = titulo.lastIndexOf(' en ');
  const direccion = corte > 0 ? titulo.slice(corte + 4).trim() : null;

  return { titulo, direccion, precio, moneda, datos, descripcion, mls };
}

(async () => {
  const pautadas = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));
  for (const p of pautadas) {
    try {
      const res = await fetch(p.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const f = parsear(await res.text());
      if (!f.precio && !f.descripcion) throw new Error('la página no trae datos (¿publicación dada de baja?)');
      p.ficha = { ...f, actualizado: new Date().toISOString().slice(0, 10) };
      console.log(`✓ ${p.id}: ${f.moneda} ${f.precio ?? '?'} · ${f.direccion ?? 'sin dirección'} · ${Object.keys(f.datos).length} datos`);
    } catch (e) {
      console.log(`✗ ${p.id}: ${e.message} — se deja la ficha anterior`);
    }
  }
  fs.writeFileSync(ARCHIVO, JSON.stringify(pautadas, null, 2) + '\n');
})();
