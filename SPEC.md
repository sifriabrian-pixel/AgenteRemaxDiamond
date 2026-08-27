# SPEC — Agente IA RE/MAX Diamond ("Diamantito")

## 1. DESCRIPCIÓN DEL PROYECTO

Agente de WhatsApp para RE/MAX Diamond — oficinas en Manta y Portoviejo, Ecuador. Vive en el número principal de la oficina y funciona como primer punto de contacto para cualquier persona que escriba.

El agente clasifica al contacto según su necesidad, responde consultas sobre propiedades puntuales del catálogo, ejecuta el flujo correspondiente y deriva al humano correcto con un resumen estructurado.

Construido como adaptación directa del agente de RE/MAX Impacta (`C:\Users\sifri\remax-impacta`), reutilizando su arquitectura probada en producción.

**Flujos activos (los mismos 4 que Impacta):**
- Captación de propietarios (vender/arrendar)
- Captación de asesores (reclutamiento)
- Comprador de propiedad
- Arrendatario de propiedad

**Novedad respecto a Impacta:** catálogo de propiedades (`src/propiedades.js`) — el agente responde consultas sobre propiedades puntuales usando datos reales del MLS, y **siempre** deriva al asesor con exclusividad de esa propiedad (Diamond no usa guardia por turno para esto, a diferencia de Impacta).

**Stack:**
- Node.js
- WhatsApp Business Cloud API (Meta) — no Baileys
- Claude API (`claude-sonnet-4-6`)
- Catálogo de propiedades: archivo local `data/propiedades.json`, generado por `scripts/importar-propiedades.js` a partir del export del MLS — no Google Sheets
- Google Sheets: solo para el sistema de guardias de `HANDOFF_PROPIETARIO`/`HANDOFF_GENERAL` (uso pendiente de confirmar, ver sección 5)
- Railway (hosting con volumen persistente)

---

## 2. ARQUITECTURA DE ARCHIVOS

```
/
├── index.js                  # Entrada principal, manejo de mensajes, dashboard, webhook
├── src/
│   ├── claude.js             # Llamadas a la API de Claude + tool use (buscar_propiedades)
│   ├── memory.js             # Estado de conversación por número de WhatsApp
│   ├── scheduler.js          # Follow-up automático (node-cron)
│   ├── guardias.js           # Sistema de guardias con Google Sheets (propietario/general)
│   ├── propiedades.js        # NUEVO — lee/filtra data/propiedades.json (busca por función, no vuelca todo)
│   ├── faq.js                # FAQ aprobado con respuestas exactas
│   ├── stats.js              # Estadísticas para el dashboard
│   └── whatsapp.js           # Envío de mensajes/plantillas vía Meta Cloud API
├── prompts/
│   └── diamond.js            # System prompt completo de Diamantito
├── scripts/
│   └── importar-propiedades.js  # Genera data/propiedades.json desde el export del MLS
├── data/
│   ├── asesores.json         # Nombre de asesor -> WhatsApp (de "LISTA DE ASESORES")
│   └── propiedades.json      # Catálogo generado — NO editar a mano, se regenera con el importer
├── .env.example
├── .gitignore
├── nixpacks.toml
├── package.json
└── SPEC.md
```

---

## 3. CATÁLOGO DE PROPIEDADES (nuevo respecto a Impacta) — RESUELTO

### 3.1 Fuentes reales usadas

1. **`reporte_propiedades-13072026.csv`** — export real del MLS de RE/MAX ("Redremax"), 844 propiedades. Viene en UTF-16LE, con un bug conocido del exportador: el par de columnas "Precio"/"Tipo de moneda" trae los *valores* en orden inverso a los *nombres* de columna (bajo el header "Precio" viene la moneda "USD", y el número real está en la celda de al lado). El importer corrige esto explícitamente — ver comentario en `scripts/importar-propiedades.js`. Si un futuro export de RE/MAX viene corregido, hay que sacar ese ajuste.
2. **`LISTA DE ASESORES 9-7-2026.xlsx`** — 43 asesores con nombre y WhatsApp (celular en formato local `0XX XXX XXXX`, normalizado a `593XXXXXXXXX`). Copiado a `data/asesores.json`.

### 3.2 Cómo se cruzan

`scripts/importar-propiedades.js`:
- Parsea el CSV (respetando comillas/comas internas), filtra `Status Listing = Activa`.
- Por cada propiedad, cruza `Nombre Agente` (del MLS) contra `data/asesores.json` por nombre normalizado (sin acentos, coincidencia exacta o por palabras contenidas — el MLS suele tener nombre completo con segundo apellido, la lista de asesores solo nombre y primer apellido).
- Descarta los datos del dueño (nombre/email/celular) — nunca se exponen al lead.
- Escribe `data/propiedades.json` con: `codigo, tipo, operacion, sector, dormitorios, banos, superficie, precio, descripcion, estado, asesorNombre, asesorWhatsapp`.

**Resultado de la corrida final del 2026-07-13:** 832 propiedades activas importadas, 832/832 con asesor identificado. 3 nombres del MLS no coincidían textualmente con la lista de asesores por errores de tipeo entre ambas fuentes; Brian confirmó que son la misma persona en cada caso, así que se agregaron como `alias` en `data/asesores.json`:
- "Jhonny Rovespierre Tuarez Guerron" → alias de **Johnny Tuárez**
- "Cinthia Alexandra Paladines Zamora" → alias de **Cynthia Paladines**
- "Gerson Ricardo Briones Perez" → alias de **Richard Briones**

`buscarAsesor()` en el importer revisa primero estos alias exactos antes de intentar el match por nombre normalizado. Si aparece un nuevo agente en un futuro export cuyo nombre no coincida con la lista de asesores, hay que agregarlo ahí de la misma forma.

### 3.3 Cómo mantenerlo actualizado

`src/propiedades.js` ya NO usa Google Sheets — lee directo `data/propiedades.json` (con caché de 1 minuto para no releer el archivo en cada mensaje). Para actualizar el catálogo cuando cambien las propiedades:

```
node scripts/importar-propiedades.js "ruta/al/nuevo-reporte.csv"
```

**Pendiente de decidir con Brian/el cliente:** si el MLS de RE/MAX permite programar el envío automático de este reporte por correo, se puede automatizar el reimport entero (leer el correo, correr el script). Si no, hay que exportarlo y correrlo a mano cada cierto tiempo (semanal alcanza, las propiedades no cambian tan rápido).

### 3.3.1 Búsqueda por herramienta (tool use), no catálogo completo en el prompt — RESUELTO

Con 832 propiedades activas, meter el catálogo entero en el system prompt salía ~30.000 tokens **en cada mensaje** (medido sobre los datos reales), con costo/latencia altos y riesgo de que el modelo confunda propiedades parecidas.

Se cambió a **function calling**: `src/claude.js` le da a Claude una herramienta `buscar_propiedades` (filtros: código, tipo, operación, sector, dormitorios mínimos, precio mín/máx). Claude la llama solo cuando el lead pregunta por algo puntual, `propiedades.buscarPropiedades()` filtra `data/propiedades.json` en memoria y devuelve como máximo 10 resultados + el total real de coincidencias (para que el agente pida más detalle si hay muchas). El loop de tool_use/tool_result vive dentro de `chat()` — a la conversación persistida en `memory.js` solo le llega el texto final, igual que antes.

Esto también resolvió el problema de precisión: en vez de "buscar en un texto gigante", Claude arma una consulta estructurada y recibe solo lo que hace falta.

### 3.4 Sistema de derivación para comprador/arrendatario — RESUELTO

Diamond **no usa guardia por turno** para estos casos: cada propiedad tiene un asesor con exclusividad. `resolverAsesor()` en `index.js`:
1. Si el lead consultó por un código de propiedad puntual → asesor asignado a esa propiedad (`asesorWhatsapp` del catálogo).
2. Si no hay propiedad puntual, o no tiene asesor asignado → `WHATSAPP_BACKUP`.

El agente tiene instrucción explícita de **no inventar** datos de propiedades que no estén en el catálogo.

---

## 4. VARIABLES DE ENTORNO

Ver `.env.example`. Resumen de lo que falta completar:

```env
ANTHROPIC_API_KEY=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_TOKEN=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=
SESSION_PATH=
GOOGLE_SHEETS_ID=                  # guardias — solo para propietario/general, ver sección 5
GOOGLE_SERVICE_ACCOUNT_KEY=
WHATSAPP_RECLUTAMIENTO=
WHATSAPP_GRUPO_RECLUTAMIENTO=
WHATSAPP_BACKUP=
NUMEROS_AUTORIZADOS=
DASHBOARD_PASSWORD=
```

---

## 5. DERIVACIÓN DE CAPTACIÓN/GENERAL — RESUELTO

`HANDOFF_PROPIETARIO` (alguien que quiere vender/arrendar una propiedad nueva, todavía no está en el catálogo) y `HANDOFF_GENERAL` van **directo al número de la oficina que atiende Grace** (`WHATSAPP_BACKUP`), sin sistema de turnos — `asesorBackup()` en `index.js`.

`guardias.js` (Google Sheet de turnos, igual que Impacta) quedó en el código pero **no se usa** en ningún flujo actual — se deja por si en el futuro hace falta, pero no hay que configurarlo para el build inicial. El comando `!guardia` sigue existiendo pero no tiene efecto en la derivación real; se puede quitar más adelante si no se va a usar.

---

## 6. TRIGGERS Y ACCIONES

| Trigger | Acción en `index.js` |
|---|---|
| `[HANDOFF_PROPIETARIO]` | `asesorBackup()` → oficina de Grace (`WHATSAPP_BACKUP`) |
| `[FOLLOWUP_PROPIETARIO]` | Fuera de horario — igual se envía a la oficina de Grace, encola el lead |
| `[FOLLOWUP_PROPIETARIO_FUERA_COBERTURA]` | Registrar para reactivación a 30 días |
| `[HANDOFF_ASESOR]` | Enviar resumen a `WHATSAPP_RECLUTAMIENTO` + `WHATSAPP_GRUPO_RECLUTAMIENTO` |
| `[FOLLOWUP_ASESOR]` | Registrar para follow-up (24h, 72h, 7d) o 30d si descalificó |
| `[HANDOFF_COMPRADOR]` | `resolverAsesor()` → asesor asignado a la propiedad (exclusividad), o `WHATSAPP_BACKUP` |
| `[HANDOFF_ARRENDATARIO]` | Igual que comprador |
| `[HANDOFF_GENERAL]` | `asesorBackup()` → oficina de Grace (`WHATSAPP_BACKUP`) |

---

## 7. PENDIENTES AL MOMENTO DE BUILD

Todo esto se copió con placeholders `[PENDIENTE: ...]` en `prompts/diamond.js` e `index.js` — hay que completarlo antes de llevar esto a producción:

| Pendiente | Notas |
|---|---|
| ~~Fuente real del catálogo de propiedades~~ | RESUELTO — export MLS + `data/asesores.json`, ver sección 3 |
| ~~Sistema de derivación (comprador/arrendatario)~~ | RESUELTO — exclusividad por propiedad, ver sección 3.4 |
| ~~Sistema de derivación (propietario/general)~~ | RESUELTO — oficina de Grace (`WHATSAPP_BACKUP`), ver sección 5. Falta el número real. |
| ~~3 agentes del MLS sin match~~ | RESUELTO — Brian confirmó que son la misma persona; se agregaron como `alias` en `data/asesores.json`. 832/832 propiedades activas con asesor asignado. |
| ~~Dirección física de la oficina~~ | RESUELTO — Av. Flavio Reyes entre Av. 24 y Calle 23, CC Manta Shopping Maincentro, Local 26, Manta, Manabí |
| ~~Sitio web de RE/MAX Diamond~~ | RESUELTO — https://www.remax.com.ec/diamond |
| ~~Correo de contacto~~ | RESUELTO — diamond@remax.com.ec (agregado a la política de privacidad) |
| ~~Zona de cobertura exacta~~ | RESUELTO (actualizado) — Diamond tiene oficina en **Manta y Portoviejo**. Dirección de Portoviejo: Av. Reales Tamarindos, al lado del Banco del Pacífico, planta baja de Plaza Prestige. `prompts/diamond.js` ahora elige la dirección de cierre según la ciudad de la propiedad/candidato (sección "OFICINAS" del prompt). |
| **Número real de WhatsApp de Diamond** | **+593 98 543 7529** — es el número que hay que registrar y verificar en Meta (Fase 2/3 de la guía), reemplazando al número de prueba actual |
| ~~Nombre de la persona responsable de selección/reclutamiento~~ | RESUELTO — Grace (mismo número que `WHATSAPP_BACKUP`, ver sección 5) |
| Número de WhatsApp de esa persona (`WHATSAPP_RECLUTAMIENTO`) | |
| Grupo de WhatsApp de reclutamiento (`WHATSAPP_GRUPO_RECLUTAMIENTO`) | |
| Número de backup para consultas generales (`WHATSAPP_BACKUP`) | |
| Números autorizados para `!guardia` (`NUMEROS_AUTORIZADOS`) | |
| ~~Video institucional para el flujo de reclutamiento~~ | RESUELTO — https://youtu.be/FpUAHag8E_c |
| ~~Link a página de carrera inmobiliaria~~ | RESUELTO — no se usa, Brian confirmó que solo se comparte el video |
| ~~Link a política de privacidad~~ | RESUELTO — el aviso de WhatsApp (`prompts/diamond.js`) y la página `/privacidad` (sección "Base legal") ahora enlazan a la ley oficial: https://www.telecomunicaciones.gob.ec/ley-y-reglamento-de-la-ley-de-proteccion-de-datos-personales/ |
| Horario real de atención (se asumió lun-vie 08:30-17:30 como Impacta) | |
| ~~Cuenta de WhatsApp Business Cloud API de Meta (modo prueba)~~ | RESUELTO — app "Agente Remax Diamond" creada, número de prueba configurado, webhook conectado y suscrito (`{WABA_ID}/subscribed_apps`), variables cargadas en Railway. Falta migrar al número real de Diamond (Fase 2/3, pendiente de que alguien registre y verifique el número real). |
| Revisión y aprobación del FAQ (`src/faq.js`) | Adaptado de Impacta, tiene supuestos sobre horario/comisión |
| ~~Preguntas del flujo de reclutamiento~~ | RESUELTO — Diamond pasó su formulario de postulación (Google Form), se integró en FLUJO 2 de `prompts/diamond.js` + `data/asesores.json` no aplica acá, ver esquema `asesor` en `src/claude.js`. **Ojo:** las opciones exactas del desplegable "¿Cómo se enteró de nosotros?" no se veían en la captura — se redactó con categorías genéricas (redes sociales / recomendación / anuncio / otro), confirmar si Diamond quiere opciones específicas. |
| ~~Bug de envío a números de Argentina/México~~ | RESUELTO en código (`src/whatsapp.js` → `formatDestino()`) — no bloquea nada, era solo un efecto secundario de probar con un número de prueba argentino. No afecta a leads reales de Ecuador. |
| Confirmar respuesta real por WhatsApp con número no-Argentina | El envío de Diamantito nunca se confirmó de punta a punta por una restricción de "lista de destinatarios" de Meta específica del número de prueba argentino (modo desarrollo). Se resuelve solo al conectar el número real de Diamond, o probando con un número de prueba de otro país. |

---

## 8. DEPLOY EN RAILWAY

Igual que Impacta:

```toml
# nixpacks.toml
[phases.install]
cmds = ["npm install"]

[phases.build]
cmds = []

[start]
cmd = "node index.js"
```

- Volumen montado, `SESSION_PATH` apuntando directo al volumen
- No usar `npm ci` — usar `npm install`
- Sin `package-lock.json` en el repo
