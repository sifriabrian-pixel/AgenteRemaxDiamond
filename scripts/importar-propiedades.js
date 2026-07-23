#!/usr/bin/env node
// Importa el export CSV del MLS de RE/MAX ("Redremax") y lo cruza con
// data/asesores.json (nombre -> whatsapp) para generar data/propiedades.json,
// que es lo que src/propiedades.js le sirve a Diamantito.
//
// Uso:
//   node scripts/importar-propiedades.js "ruta/al/reporte_propiedades.csv"
//
// Se puede volver a correr cada vez que llega un export nuevo del MLS —
// simplemente sobrescribe data/propiedades.json.

const fs = require('fs');
const path = require('path');

const ASESORES_PATH = path.join(__dirname, '../data/asesores.json');
const SALIDA_PATH = path.join(__dirname, '../data/propiedades.json');

// El export de RE/MAX viene en UTF-16LE con CRLF, con celdas entre comillas
// y algunos campos numéricos forzados a texto por Excel como ="valor".
function leerCsv(rutaArchivo) {
  const buf = fs.readFileSync(rutaArchivo);
  const esUtf16 = buf[0] === 0xff && buf[1] === 0xfe;
  const texto = esUtf16 ? buf.toString('utf16le') : buf.toString('utf8');
  return texto.split(/\r\n/).filter((l) => l.length > 0);
}

// Parser de una línea CSV respetando comillas y comas internas.
function parsearLinea(linea) {
  const celdas = [];
  let actual = '';
  let dentroComillas = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (dentroComillas) {
      if (c === '"') {
        if (linea[i + 1] === '"') {
          actual += '"';
          i++;
        } else {
          dentroComillas = false;
        }
      } else {
        actual += c;
      }
    } else if (c === '"') {
      dentroComillas = true;
    } else if (c === ',') {
      celdas.push(actual);
      actual = '';
    } else {
      actual += c;
    }
  }
  celdas.push(actual);
  // Excel fuerza algunos campos a texto con ="valor" — quitamos ese prefijo.
  return celdas.map((c) => c.replace(/^="(.*)"$/, '$1').trim());
}

function normalizarNombre(nombre) {
  return nombre
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita acentos
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buscarAsesor(nombreAgenteMls, asesores) {
  const objetivo = normalizarNombre(nombreAgenteMls);
  const palabrasObjetivo = objetivo.split(' ').filter(Boolean);

  // 1. Alias explícito — nombre tal cual aparece en el MLS, confirmado a mano
  //    (ej. errores de tipeo entre el MLS y la lista de asesores: "Jhonny" vs "Johnny")
  let match = asesores.find((a) =>
    (a.alias || []).some((al) => normalizarNombre(al) === objetivo)
  );
  if (match) return match;

  // 2. Coincidencia exacta de nombre
  match = asesores.find((a) => normalizarNombre(a.nombre) === objetivo);
  if (match) return match;

  // 3. El nombre corto de la lista de asesores está contenido en el nombre completo del MLS
  //    (la lista de asesores suele tener "Nombre Apellido", el MLS "Nombre Apellido Segundo-apellido")
  match = asesores.find((a) => {
    const palabrasAsesor = normalizarNombre(a.nombre).split(' ').filter(Boolean);
    return palabrasAsesor.every((p) => palabrasObjetivo.includes(p));
  });
  return match || null;
}

function construirDescripcion(v) {
  const partes = [
    v('Dirección'),
    v('Barrio') || v('Localidad'),
    v('Ambientes') ? `${v('Ambientes')} ambientes` : null,
    v('Antigüedad') ? `antigüedad ${v('Antigüedad')} años` : null,
    v('Estado de la propiedad'),
  ].filter(Boolean);
  return partes.join(' · ');
}

function elegirSuperficie(v) {
  const total = v('Total construido');
  const terreno = v('Terreno');
  const cubierta = v('Sup. cubierta');
  if (total) return `${total} m²`;
  if (terreno) return `${terreno} m² de terreno`;
  if (cubierta) return `${cubierta} m²`;
  return '';
}

function main() {
  const rutaCsv = process.argv[2];
  if (!rutaCsv) {
    console.error('Uso: node scripts/importar-propiedades.js "ruta/al/reporte.csv"');
    process.exit(1);
  }

  const asesores = JSON.parse(fs.readFileSync(ASESORES_PATH, 'utf8'));

  const lineas = leerCsv(rutaCsv).filter((l) => l.trim() !== 'sep=,');
  const encabezados = parsearLinea(lineas[0]);

  // OJO: este export trae "Tipo de moneda" duplicado en el encabezado, y además
  // el par "Precio" / "Tipo de moneda" viene con los VALORES en orden inverso al
  // que dicen los nombres de columna (la celda bajo "Precio" trae la moneda, ej.
  // "USD", y la celda bajo "Tipo de moneda" trae el monto numérico, ej. "80000").
  // Verificado a mano contra 20 filas reales del export del 2026-07-13 — si un
  // futuro export de RE/MAX viene con las columnas corregidas, hay que sacar
  // este ajuste y volver a usar indiceDe('Precio') directo.
  const indicePrecioHeader = encabezados.indexOf('Precio');

  const filas = lineas.slice(1).map((linea) => parsearLinea(linea));

  function accesor(fila) {
    return (nombreColumna) => {
      const idx = encabezados.indexOf(nombreColumna);
      return idx === -1 ? '' : (fila[idx] || '');
    };
  }

  let sinMatch = 0;
  const propiedades = filas
    .filter((fila) => (fila[encabezados.indexOf('Status Listing')] || '').toLowerCase() === 'activa')
    .map((fila) => {
      const v = accesor(fila);
      const nombreAgente = v('Nombre Agente');
      const asesor = buscarAsesor(nombreAgente, asesores);
      if (!asesor) sinMatch++;
      return {
        codigo: v('Redremax ID') || v('MLSID'),
        tipo: v('Tipo de Propiedad'),
        operacion: v('Tipo de Operación'),
        sector: v('Barrio') || v('Localidad'),
        dormitorios: v('Dormitorios') || '',
        banos: '', // no viene en este export
        superficie: elegirSuperficie(v),
        // Excel a veces deja un "=" suelto delante de precios con decimales (sin comillas)
        precio: (fila[indicePrecioHeader + 1] || '').replace(/^=/, ''),
        descripcion: construirDescripcion(v),
        estado: 'activa',
        asesorNombre: asesor ? asesor.nombre : (nombreAgente || null),
        asesorWhatsapp: asesor ? asesor.whatsapp : null,
      };
    });

  fs.writeFileSync(SALIDA_PATH, JSON.stringify(propiedades, null, 2));

  console.log(`[importar-propiedades] Total filas en el CSV: ${filas.length}`);
  console.log(`[importar-propiedades] Propiedades activas importadas: ${propiedades.length}`);
  console.log(`[importar-propiedades] Sin asesor asignado (nombre no encontrado en data/asesores.json): ${sinMatch}`);
  console.log(`[importar-propiedades] Escrito en: ${SALIDA_PATH}`);
}

main();
