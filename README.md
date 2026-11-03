# HPM-FE — Middleware de Facturación Electrónica AFIP/ARCA

API REST en Node.js/Express que recibe JSON y factura contra los web services de AFIP
(WSAA + wsfev1). El cliente (HPM) se autentica con **una API Key global** (`HPM_API_KEY`) y
elige la **empresa emisora por `cuit_emisor`** en cada request; el `.p12` de cada empresa
vive cifrado en MySQL.

> Estado: núcleo funcional + integración HPM implementados (auth global, resolución por
> `cuit_emisor`, emisión idempotente por `clave_idempotencia`, observaciones AFIP). Se
> publicará en `https://fe.hpm.ar`. Diseño de la integración:
> [`../hpm/docs/superpowers/specs/2026-09-07-http-get-factura-electronica-design.md`](../hpm/docs/superpowers/specs/2026-09-07-http-get-factura-electronica-design.md).

---

## 1. Stack

| Componente        | Tecnología                                        |
|-------------------|---------------------------------------------------|
| Runtime           | Node.js 18+ (usa `node --watch` en dev)           |
| Framework HTTP    | Express 4.18                                       |
| Base de datos     | MySQL 8+ vía `mysql2/promise` (pool)               |
| Criptografía      | `node-forge` (PKCS#12, PKCS#7/CMS) + `crypto` core |
| Validación        | Joi 17                                             |
| Cliente HTTP SOAP | axios 1.7                                          |
| Parseo XML        | xml2js 0.6                                         |
| Rate limiting     | express-rate-limit 7.4                             |
| Upload de archivos| multer 1.4 (memory storage)                        |
| Configuración     | dotenv 16.4                                        |

Scripts (`package.json`):

- `npm start` → `node src/index.js`
- `npm run dev` → `node --watch src/index.js`

---

## 2. Arquitectura

```
HPM (VB6)
   │  JSON + Authorization: Bearer <HPM_API_KEY> + body.cuit_emisor
   ▼
HPM-FE API (Express)
   │  auth → resolveEmpresa → rateLimit → validate → handler → errorHandler
   ▼
├── MySQL: empresas, token_cache, facturas_log, emisiones_idempotencia
└── AFIP: WSAA (login CMS) + wsfev1 (facturación) vía SOAP/XML
```

### Flujo de emisión (`POST /api/v1/factura/emitir`)

1. `auth.js` compara el `Bearer` contra `HPM_API_KEY` (tiempo constante).
2. `resolveEmpresa.js` busca la empresa por `body.cuit_emisor` y adjunta `req.empresa`
   (incluye `p12_data` y password cifrada). 422 si no está registrada / inactiva.
3. `rateLimit.js` verifica el límite (key = `req.empresa.id`).
4. `validate('emitir')` valida el body con Joi.
5. **Idempotencia** (`idempotencia.reclamar`): `INSERT` de una fila `(empresa_id, clave)`
   en `emisiones_idempotencia` con estado `en_curso`. Si ya existe:
   - estado `listo` → devuelve el CAE guardado con `reintento: true`, **sin llamar a AFIP**.
   - estado `en_curso` → `409` (otra request la está procesando).
6. `wsaa.obtenerLoginTicketResponse(empresa)`: token de `token_cache` (margen 5 min) o
   nuevo login CMS firmado con el `.p12`.
7. `wsfev1.FECAESolicitar`: `CbteNro = FECompUltimoAutorizado + 1`, arma el SOAP, lo envía,
   parsea CAE + `observaciones[]`. Errores `Errors/Err` → `Error` con `.codigo_afip`.
8. Se registra en `facturas_log`. Si `resultado === 'A'` → `idempotencia.confirmar`
   (fila a `listo`); si rechazo o excepción → `idempotencia.liberar` (borra la fila, se
   puede reintentar).
9. Respuesta: `{ ok, cae, vencimiento_cae, numero_comprobante, resultado, observaciones, reintento }`.

---

## 3. Base de datos

Migraciones: [src/db/migrations/001_schema.sql](src/db/migrations/001_schema.sql),
[src/db/migrations/002_idempotencia.sql](src/db/migrations/002_idempotencia.sql)

### `empresas`
| Columna                  | Tipo           | Notas                                        |
|--------------------------|----------------|----------------------------------------------|
| `id`                     | INT PK AI      |                                              |
| `cuit`                   | VARCHAR(11)    | UNIQUE                                        |
| `razon_social`           | VARCHAR(255)   |                                              |
| `p12_data`               | LONGBLOB       | Contenido del `.p12` (sin cifrar, BLOB)       |
| `p12_password_encrypted` | VARCHAR(500)   | AES-256-GCM: `iv:tag:ciphertext` (hex)        |
| `api_key`                | VARCHAR(64)    | UNIQUE. **Ya no se usa para autenticar** (queda por compat); la auth es por `HPM_API_KEY` |
| `activo`                 | BOOLEAN        | default TRUE                                  |
| `created_at`             | TIMESTAMP      | default `CURRENT_TIMESTAMP`                   |

Se busca por `cuit` (no por `api_key`): `WHERE cuit = ? AND activo = 1`.

### `token_cache`
| Columna      | Tipo        | Notas                                            |
|--------------|-------------|--------------------------------------------------|
| `id`         | INT PK AI   |                                                  |
| `empresa_id` | INT         | UNIQUE, FK → `empresas(id)` ON DELETE CASCADE     |
| `token`      | TEXT        | Token WSAA                                        |
| `sign`       | TEXT        | Sign WSAA                                         |
| `expires_at` | DATETIME    | `expirationTime` del ticket                       |
| `created_at` | TIMESTAMP   |                                                  |

La constraint UNIQUE en `empresa_id` habilita el upsert `INSERT ... ON DUPLICATE KEY UPDATE`.

### `facturas_log`
| Columna      | Tipo         | Notas                                           |
|--------------|--------------|-------------------------------------------------|
| `id`         | BIGINT PK AI |                                                 |
| `empresa_id` | INT          | FK → `empresas(id)` ON DELETE CASCADE            |
| `endpoint`   | VARCHAR(100) | Ruta HTTP sin query string                       |
| `request`    | JSON         | Body del request                                 |
| `response`   | JSON         | Respuesta devuelta (solo en éxito de `emitir`)   |
| `cae`        | VARCHAR(20)  |                                                 |
| `resultado`  | VARCHAR(1)   | `A`=aprobado, `R`=rechazado, `P`=parcial          |
| `error`      | TEXT         | Mensaje de error (se escribe desde `errorHandler`)|
| `created_at` | TIMESTAMP    |                                                 |

Índices: `idx_facturas_log_empresa`, `idx_facturas_log_cae`.

### `emisiones_idempotencia`
| Columna              | Tipo         | Notas                                                   |
|----------------------|--------------|---------------------------------------------------------|
| `id`                 | BIGINT PK AI |                                                         |
| `empresa_id`         | INT          | FK → `empresas(id)` ON DELETE CASCADE                    |
| `clave`              | VARCHAR(64)  | La `clave_idempotencia` que manda HPM (= `id` de la OC)  |
| `estado`             | VARCHAR(10)  | `en_curso` (reclamada, emitiendo) · `listo` (con CAE)    |
| `cae` / `vencimiento_cae` / `numero_comprobante` / `resultado` | | Datos del CAE, sólo cuando `estado = listo` |
| `punto_vta` / `tipo_cbte` | INT      | Referencia                                               |
| `created_at` / `updated_at` | TIMESTAMP |                                                       |

`UNIQUE (empresa_id, clave)` — evita que dos requests simultáneos con la misma clave emitan
dos comprobantes. La fila se **reclama antes** de llamar a AFIP y se **borra** si AFIP
rechaza o falla la llamada (para permitir reintento). Ver `src/services/idempotencia.js`.

---

## 4. Configuración (`.env`)

Ver [.env.example](.env.example).

| Variable             | Descripción                                                              |
|----------------------|------------------------------------------------------------------------- |
| `PORT` / `HOST`      | Puerto HTTP (default 3000) / interfaz de bind (default `0.0.0.0`)        |
| `DB_HOST`/`DB_PORT`  | MySQL (default `localhost:3306`)                                         |
| `DB_USER`/`DB_PASS`/`DB_NAME` | Credenciales y base                                             |
| `AFIP_URL`           | Endpoint wsfev1 (prod: `servicios1.afip.gov.ar/wsfev1/service.asmx`)     |
| `WSAA_URL`           | Endpoint WSAA LoginCms (prod: `wsaa.afip.gov.ar/ws/services/LoginCms`)   |
| `P12_ENCRYPTION_KEY` | 32 bytes hex para AES-256-GCM (`crypto.randomBytes(32).toString('hex')`) |
| `ADMIN_SECRET`       | Secret para rutas `/admin` (`openssl rand -hex 32`)                      |
| `HPM_API_KEY`        | **API Key única de HPM** (`Authorization: Bearer …`). `randomBytes(32).toString('hex')` |
| `RATE_LIMIT_RPS`     | Requests por segundo por empresa (default 5)                             |

El pool MySQL fuerza `timezone: '+00:00'`. Homologación: descomentar las URLs `wswhomo` /
`wsaahomo` en el `.env`.

---

## 5. Endpoints

Todas las rutas bajo `/api/v1` (salvo `/admin`) requieren `Authorization: Bearer <HPM_API_KEY>`.
Las de `auth` / `factura` / `parametros` requieren además `cuit_emisor` (body en POST,
query en GET) para resolver la empresa. Respuestas siempre con forma `{ ok: boolean, ... }`.

### Autenticación

| Método | Ruta                  | Body                    | Descripción                              |
|--------|-----------------------|-------------------------|------------------------------------------|
| POST   | `/api/v1/auth/login`  | `{ cuit_emisor }`       | Fuerza renovación del Token/Sign WSAA (limpia cache) |

Respuesta: `{ ok, token, sign, expira }`.

### Facturación — [src/routes/factura.js](src/routes/factura.js)

| Método | Ruta                                | Validación            | Descripción                              |
|--------|-------------------------------------|-----------------------|------------------------------------------|
| GET    | `/api/v1/factura/ultimo-comprobante`| `ultimoComprobante` (query) + `?cuit_emisor=` | Último número autorizado (`FECompUltimoAutorizado`) |
| POST   | `/api/v1/factura/emitir`            | `emitir` (body)       | Emite comprobante idempotente (`FECAESolicitar`), numeración automática, log en `facturas_log` |
| GET    | `/api/v1/factura/consultar`         | `consultar` (query) + `?cuit_emisor=` | Consulta un comprobante emitido (`FECompConsultar`) |

Body de `emitir` (campos nuevos en **negrita**):

```jsonc
{
  "cuit_emisor": "30714794295",   // ← requerido, elige la empresa
  "clave_idempotencia": 123456,   // ← requerido, = id de la OC en HPM
  "tipo_cbte": 6, "punto_vta": 4, "fecha_cbte": "20260907", "concepto": 1,
  "tipo_doc": 80, "nro_doc": 30711479295, "condicion_iva_receptor_id": 1,
  "imp_total": 121, "imp_neto": 100, "imp_iva": 21,
  "moneda": "PES", "moneda_cotizacion": 1,   // opcionales, default PES / 1
  "iva": [ { "id": 5, "base_imp": 100, "importe": 21 } ],
  "tributos": [ { "id": 3, "desc": "IIBB", "base_imp": 100, "alic": 1, "importe": 1 } ]  // desc opcional
}
```

Respuesta de `emitir`:
`{ ok, cae, vencimiento_cae, numero_comprobante, resultado, observaciones: [{codigo, mensaje}], reintento }`
— `reintento: true` cuando la clave ya se había emitido (devuelve el CAE guardado).

### Parámetros AFIP — [src/routes/parametros.js](src/routes/parametros.js)

| Método | Ruta                                     | Método AFIP                    |
|--------|------------------------------------------|--------------------------------|
| GET    | `/api/v1/parametros/tipos-comprobante`   | `FEParamGetTiposCbte`          |
| GET    | `/api/v1/parametros/tipos-documento`     | `FEParamGetTiposDoc`           |
| GET    | `/api/v1/parametros/tipos-iva`           | `FEParamGetAlicIva`            |
| GET    | `/api/v1/parametros/cotizacion/:moneda`  | `FEParamGetCotizacion`         |
| GET    | `/api/v1/parametros/puntos-venta`        | `FEParamGetPtosVenta`          |

### Estado / salud — [src/routes/consultas.js](src/routes/consultas.js)

| Método | Ruta               | Descripción                                            |
|--------|--------------------|-------------------------------------------------------|
| GET    | `/api/v1/dummy`    | `FEDummy` de AFIP (`appserver`/`dbserver`/`authserver`)|
| GET    | `/api/v1/health`   | `SELECT 1` a MySQL + `uptime`                          |

> Nota: `/dummy` y `/health` están montados bajo el middleware protegido, por lo que
> también requieren API Key válida.

### Admin — [src/routes/admin.js](src/routes/admin.js)

Requieren header `X-Admin-Secret: <ADMIN_SECRET>` (comparación en tiempo constante).
No aplican rate limit de empresa.

| Método | Ruta                                    | Body                                        | Descripción |
|--------|-----------------------------------------|---------------------------------------------|-------------|
| POST   | `/api/v1/admin/empresas`                | `multipart`: `cuit`, `razon_social`, `p12_password`, `p12` (file) | Registra empresa, genera API Key (devuelta una única vez) |
| PUT    | `/api/v1/admin/empresas/:id/certificado`| `multipart`: `p12_password`, `p12` (file)   | Reemplaza el `.p12` y limpia el token cacheado |
| PATCH  | `/api/v1/admin/empresas/:id`            | `{ "activo": boolean }`                     | Activa/desactiva la empresa |

Límite de upload: 512 KB, extensión `.p12` o mimetype pkcs12/octet-stream.

### Códigos HTTP

| Código | Situación                                              |
|--------|-------------------------------------------------------|
| 200    | Éxito (incluye `resultado: "R"` de AFIP con `observaciones`) |
| 401    | `HPM_API_KEY` ausente o inválida                      |
| 403    | `X-Admin-Secret` inválido                             |
| 404    | Empresa no encontrada (rutas admin por `:id`)         |
| 409    | Ya hay una emisión en curso para esa `clave_idempotencia` |
| 422    | Validación / `cuit_emisor` ausente / CUIT emisor no registrado |
| 429    | Rate limit excedido                                   |
| 500    | Error interno o error de AFIP (con `codigo_afip` si aplica) |

---

## 6. Middlewares — [src/middleware/](src/middleware/)

| Archivo             | Función                                                                              |
|--------------------|------------------------------------------------------------------------------------- |
| `auth.js`          | Compara `Bearer` contra `HPM_API_KEY` (`crypto.timingSafeEqual`); 401 si no coincide |
| `resolveEmpresa.js`| Lee `cuit_emisor` (body/query), `SELECT ... WHERE cuit = ? AND activo = 1`, adjunta `req.empresa`; 422 si falta o no existe |
| `adminAuth.js`     | Compara `X-Admin-Secret` con `ADMIN_SECRET` usando `crypto.timingSafeEqual`          |
| `rateLimit.js`     | `express-rate-limit`, ventana 1 s, `max = RATE_LIMIT_RPS`, key = `req.empresa.id` (o `global`), 429 |
| `validate.js`      | Factory `validate(schemaName, source)` con Joi; `abortEarly:false`, `stripUnknown:true`; 422 con `detalles[]` |
| `errorHandler.js`  | Catch-all; si hay `req.empresa` inserta el error en `facturas_log`; responde `{ ok:false, error, codigo_afip? }` con `err.status || 500` |

Orden en [src/app.js](src/app.js):

```
/api/v1/admin      → adminAuth → router → errorHandler
/api/v1/auth       → auth → resolveEmpresa → rateLimit → router → errorHandler
/api/v1/factura    → auth → resolveEmpresa → rateLimit → router → errorHandler
/api/v1/parametros → auth → resolveEmpresa → rateLimit → router → errorHandler
/api/v1/*          → auth → rateLimit → consultas (dummy, health) → errorHandler
```

### Schemas de validación (`validate.js`)

- **`emitir`**: `cuit_emisor` (`^\d{11}$`) y `clave_idempotencia` (entero) **requeridos**.
  Valida cabecera, documento, importes, `condicion_iva_receptor_id` (obligatorio AFIP).
  `moneda` / `moneda_cotizacion` opcionales (default `"PES"` / `1`). `tributos[].desc`
  opcional (default `""`). `fecha_serv_desde/hasta` y `fecha_venc_pago` obligatorias solo
  si `concepto ∈ {2,3}`. Objetos opcionales `comprobante_asociado` (NC/ND) y `leyenda`.
  Fechas `^\d{8}$` (AAAAMMDD).
- **`ultimoComprobante`**: `pto_vta`, `tipo_cbte`.
- **`consultar`**: `tipo_cbte`, `pto_vta`, `nro`.
- **`patchEmpresa`**: `activo` (boolean, requerido).

---

## 7. Servicios — [src/services/](src/services/)

### `crypto.js`
- `encryptPassword(plain)` → AES-256-GCM con `P12_ENCRYPTION_KEY`; salida `iv:tag:data` en hex.
- `decryptPassword(str)` → descifra en memoria.
- `loadP12(buffer, password)` → extrae `cert` y `privateKey` del PKCS#12 con `node-forge`.
- `signCMS(xml, p12Buffer, password)` → firma PKCS#7 SignedData (SHA-256, atributos
  autenticados: contentType, messageDigest, signingTime); devuelve DER en Base64.

### `wsaa.js`
- `obtenerLoginTicketResponse(empresa)` → devuelve `{ token, sign }` desde cache o
  autenticando contra WSAA; persiste el resultado con `tokenCache.set`.
- `loginCMS(cmsBase64)` → arma el SOAP `loginCms`, lo envía, parsea el `loginCmsReturn`
  (doble parseo XML: envelope y ticket interno), detecta `Fault`, devuelve
  `{ token, sign, expiresAt }`.

### `wsfev1.js`
`extractErrors()` normaliza `Errors/Err` (uno o varios) y devuelve un `Error` con mensaje
`"[code] msg | ..."` y `.codigo_afip` (primer código); los métodos lo lanzan.
`extractObservaciones()` normaliza `Observaciones/Obs` → `[{ codigo, mensaje }]`. Todos los
métodos detectan `soapenv:Fault`.

| Función                                        | Método AFIP / salida                                            |
|------------------------------------------------|----------------------------------------------------------------|
| `FEDummy()`                                    | `{ appserver, dbserver, authserver }` (sin auth AFIP)           |
| `FECompUltimoAutorizado(empresa, ptoVta, tipoCbte)` | `{ ultimo_numero }`                                        |
| `FECAESolicitar(empresa, data)`                | Calcula `CbteNro`, emite; `{ cae, vencimiento_cae, numero_comprobante, resultado, observaciones[] }` |
| `FECompConsultar(empresa, ptoVta, tipoCbte, nro)`   | `{ cae, vencimiento_cae, resultado, fecha_cbte, imp_total }` |
| `FEParamGet(empresa, method, itemKey)`         | Genérico → `[{ id, desc }]`                                     |
| `FEParamGetPtosVenta(empresa)`                 | `[{ id: Nro, desc: EmisionTipo }]`                              |
| `FECotizacionMoneda(empresa, moneda)`          | `{ moneda, cotizacion, fecha }`                                 |

### `tokenCache.js`
- `get(empresaId)` → token solo si `expires_at > NOW() + 5 min`.
- `set(empresaId, token, sign, expiresAt)` → upsert `ON DUPLICATE KEY UPDATE`.
- `clear(empresaId)` → borra la fila (renovación forzada / cambio de certificado).

---

## 8. Utils — [src/utils/](src/utils/)

### `soap.js`
`callSoap(url, action, xml)` → `axios.post` con `Content-Type: text/xml; charset=utf-8`,
header `SOAPAction`, timeout 30 s. Devuelve `response.data` (XML crudo).

### `xml.js`
- `parseXml(xml)` → `xml2js` con `explicitArray:false`, `ignoreAttrs:true`,
  `stripPrefix` (quita prefijos de namespace).
- `toAfipDate(date)` → ISO con offset fijo `-03:00`.
- `buildLoginTicketRequest(service)` → XML del ticket (`generationTime` −10 min,
  `expirationTime` +12 h −10 min, `uniqueId` = epoch en segundos).
- `buildLoginCmsSoap(cms)` y builders SOAP de wsfev1:
  `buildFEDummySoap`, `buildFECompUltimoAutorizadoSoap`, `buildFECAESolicitarSoap`,
  `buildFECompConsultarSoap`, `buildParamSoap(method, ..., extra)`.
- `buildFECAESolicitarSoap` arma condicionalmente los bloques `Iva`, `Tributos`,
  fechas de servicio (`concepto !== 1`), `CbtesAsoc` y `Opcionales` (leyenda). Importes
  formateados con `.toFixed(2)`.

Namespace wsfev1: `http://ar.gov.afip.dif.FEV1/`.
Construcción manual de XML por template strings (sin librería SOAP pesada).

---

## 9. Estructura de archivos

```
src/
├── index.js                   Entry point: verifica DB (SELECT 1) y levanta el server
├── app.js                     Express app: monta middlewares y routers
├── config/
│   ├── index.js               Carga .env → objeto config
│   └── database.js            Pool mysql2/promise (connectionLimit 10, tz +00:00)
├── db/migrations/
│   ├── 001_schema.sql         DDL: empresas, token_cache, facturas_log
│   └── 002_idempotencia.sql   DDL: emisiones_idempotencia
├── middleware/
│   ├── auth.js                Bearer == HPM_API_KEY (timingSafeEqual)
│   ├── resolveEmpresa.js      cuit_emisor → req.empresa
│   ├── adminAuth.js           X-Admin-Secret (timingSafeEqual)
│   ├── rateLimit.js           express-rate-limit por empresa
│   ├── validate.js            Joi schemas + factory
│   └── errorHandler.js        Catch-all + log de errores
├── services/
│   ├── crypto.js              AES-256-GCM, PKCS#12, firma CMS
│   ├── wsaa.js                Autenticación WSAA + cache
│   ├── wsfev1.js              Facturación / consultas / parámetros
│   ├── idempotencia.js        reclamar / confirmar / liberar
│   └── tokenCache.js          get/set/clear de token_cache
├── routes/
│   ├── auth.js                POST /auth/login
│   ├── factura.js             ultimo-comprobante, emitir, consultar
│   ├── consultas.js           dummy, health
│   ├── parametros.js          tablas paramétricas AFIP
│   └── admin.js               alta / cambio de certificado / activar-desactivar
└── utils/
    ├── soap.js                Cliente HTTP SOAP (axios)
    └── xml.js                 parseXml + builders SOAP

docs/superpowers/specs/2026-06-23-hpm-fe-api-design.md   Especificación de diseño original
.env.example                  Template de variables de entorno
.gitignore                    node_modules, .env, *.p12, *.pfx
package.json
```

---

## 10. Puesta en marcha

```bash
# 1. Dependencias
npm install

# 2. Base de datos
mysql -u root -p -e "CREATE DATABASE hpm_fe CHARACTER SET utf8mb4"
mysql -u root -p hpm_fe < src/db/migrations/001_schema.sql
mysql -u root -p hpm_fe < src/db/migrations/002_idempotencia.sql

# 3. Configuración
cp .env.example .env
#   completar DB_*, generar P12_ENCRYPTION_KEY, ADMIN_SECRET y HPM_API_KEY:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 4. Arrancar
npm run dev      # desarrollo (node --watch)
npm start        # producción

# 5. Registrar cada empresa emisora (un .p12 por CUIT)
curl -X POST http://localhost:3000/api/v1/admin/empresas \
  -H "X-Admin-Secret: $ADMIN_SECRET" \
  -F cuit=20111111112 -F razon_social="Mi Empresa SA" \
  -F p12_password=secreto -F p12=@certificado.p12
#   (la api_key que devuelve se ignora; HPM usa HPM_API_KEY)

# 6. Emitir (así llama HPM)
curl -X POST http://localhost:3000/api/v1/factura/emitir \
  -H "Authorization: Bearer $HPM_API_KEY" -H "Content-Type: application/json" \
  -d '{"cuit_emisor":"20111111112","clave_idempotencia":123,"tipo_cbte":6,"punto_vta":1,
       "fecha_cbte":"20260907","concepto":1,"tipo_doc":80,"nro_doc":30711479295,
       "condicion_iva_receptor_id":1,"imp_total":121,"imp_neto":100,"imp_iva":21,
       "iva":[{"id":5,"base_imp":100,"importe":21}]}'
```

### Pruebas locales

`.env` con `DB_USER=root`, `AFIP_URL`/`WSAA_URL` de homologación (`wswhomo` / `wsaahomo`),
MySQL local (p. ej. WAMP). Producción: `https://fe.hpm.ar` con URLs de AFIP producción.

---

## 11. Notas de seguridad

- **Password del `.p12`**: cifrada con AES-256-GCM; la clave vive solo en `.env`, nunca en DB.
- **`.p12`**: se guarda como BLOB (sin cifrar) en `empresas.p12_data`; sin dependencia del filesystem.
- **API Key**: `HPM_API_KEY` única en `.env`, comparada en tiempo constante. Puede emitir
  por cualquier CUIT cargado → mitigar con TLS + IP allowlist en nginx (despliegue interno).
- **Admin**: comparación en tiempo constante contra `ADMIN_SECRET`.
- **Logs**: `facturas_log` y el error handler nunca guardan passwords ni contenido de certificados.
- **TLS**: se asume reverse proxy (nginx) con HTTPS por delante (`fe.hpm.ar`).
- **Rate limit**: 5 req/s por empresa por defecto.

---

## 12. Pendiente / no implementado

- No hay tests automatizados (sí se verificó a mano: validación, auth, `resolveEmpresa`,
  idempotencia — reclamar/confirmar/liberar, 409, `reintento:true`).
- No hay script de seed (el alta se hace por el endpoint admin).
- No se persiste `response` en `facturas_log` para endpoints distintos de `emitir`.
- No hay endpoint para listar/consultar empresas ni logs.
- No hay manejo de emisión en lote (`CantReg` fijo en 1; HPM hace una llamada por comprobante).
- `FEDummy` contra homologación devolvió un XML inesperado en la prueba (endpoint no usado
  por HPM; a revisar aparte).
- Falta el deploy en `fe.hpm.ar` (nginx `location` + MySQL + `.env` de producción) y el
  alta de los CUIT emisores reales.
- El repositorio no está inicializado como git.
```
