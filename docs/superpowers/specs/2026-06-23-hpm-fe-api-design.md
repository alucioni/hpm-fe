# HPM-FE API — Especificación de Diseño

> API REST para facturación electrónica AFIP/ARCA (Argentina). Middleware multi-tenant en Node.js que recibe JSON y se comunica con los web services WSAA + wsfev1 de AFIP.

---

## 1. Arquitectura General

```
┌─────────────┐     JSON/HTTPS (API Key)    ┌─────────────────────────────────┐
│  Cliente     │ ──────────────────────────> │  HPM-FE API (Node.js/Express)   │
│ (ERP/web)    │ <────────────────────────── │                                 │
└─────────────┘                              │  - Auth via API Key por empresa │
                                             │  - Rate limit por API Key       │
                                             │  - Validación de schemas        │
                                             │  - Cache de Token/Sign en MySQL │
                                             │  - Firma CMS + SOAP contra AFIP │
                                             └────────┬───────────┬────────────┘
                                                      │           │
                                              SOAP/XML │           │ MySQL
                                                      ▼           ▼
                                          ┌────────────────┐  ┌──────────────┐
                                          │ AFIP WSAA      │  │    MySQL     │
                                          │ (auth)         │  │ - empresas   │
                                          │ AFIP wsfev1    │  │ - tokens     │
                                          │ (facturación)  │  │ - logs       │
                                          └────────────────┘  └──────────────┘
```

### Flujo típico — Emitir factura

1. Cliente → `POST /api/v1/factura/emitir` con JSON + `Authorization: Bearer <api_key>`
2. Middleware `auth.js` valida API Key → obtiene `empresa_id` desde MySQL
3. Middleware `rateLimit.js` verifica que la empresa no superó el límite configurado
4. Servicio `wsaa.js` verifica cache en `token_cache` (MySQL). Si expiró, renueva contra WSAA
5. Servicio `wsfev1.js` construye XML SOAP del request, lo firma con PKCS#7/CMS usando el p12, envía a AFIP
6. Resultado (CAE o error) se guarda en `facturas_log` y se devuelve como JSON

---

## 2. Stack Tecnológico

| Componente | Tecnología |
|-----------|------------|
| Runtime | Node.js 18+ |
| Framework HTTP | Express |
| DB | MySQL 8+ (mysql2 driver) |
| Criptografía | node-forge (PKCS#12, PKCS#7/CMS signing) |
| Validación | Joi |
| HTTP Client | axios (para SOAP contra AFIP) |
| Rate limiting | express-rate-limit |
| File upload | multer |
| Config | dotenv |

---

## 3. Base de Datos (MySQL)

```sql
CREATE TABLE empresas (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  cuit        VARCHAR(11) NOT NULL UNIQUE,
  razon_social VARCHAR(255) NOT NULL,
  p12_data    LONGBLOB NOT NULL,
  p12_password_encrypted VARCHAR(500) NOT NULL,
  api_key     VARCHAR(64) NOT NULL UNIQUE,
  activo      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE token_cache (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  empresa_id  INT NOT NULL UNIQUE,
  token       TEXT NOT NULL,
  sign        TEXT NOT NULL,
  expires_at  DATETIME NOT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE
);

CREATE TABLE facturas_log (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  empresa_id  INT NOT NULL,
  endpoint    VARCHAR(100) COMMENT 'Ruta HTTP del request, ej: /api/v1/factura/emitir',
  request     JSON,
  response    JSON,
  cae         VARCHAR(20),
  resultado   VARCHAR(1) COMMENT 'A=aprobado, R=rechazado, P=parcial',
  error       TEXT,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE
);

CREATE INDEX idx_token_cache_empresa ON token_cache(empresa_id);
CREATE INDEX idx_facturas_log_empresa ON facturas_log(empresa_id);
CREATE INDEX idx_facturas_log_cae ON facturas_log(cae);
```

### Notas sobre seguridad de p12

- El contenido del `.p12` se almacena como `LONGBLOB` directamente en la DB, sin dependencia del filesystem
- `p12_password_encrypted` se cifra con AES-256-GCM usando `P12_ENCRYPTION_KEY` del `.env`
- En runtime se descifra en memoria, nunca se loggea

### Upsert en token_cache

La constraint `UNIQUE` en `empresa_id` permite usar `INSERT ... ON DUPLICATE KEY UPDATE` en `tokenCache.js`:

```sql
INSERT INTO token_cache (empresa_id, token, sign, expires_at)
VALUES (?, ?, ?, ?)
ON DUPLICATE KEY UPDATE token = VALUES(token), sign = VALUES(sign), expires_at = VALUES(expires_at);
```

---

## 4. API Endpoints

Todas las rutas requieren header: `Authorization: Bearer <api_key>`

### HTTP Status Codes

| Código | Situación |
|--------|-----------|
| `200` | Éxito |
| `401` | API Key ausente, inválida o empresa inactiva |
| `403` | Admin secret inválido (rutas `/admin`) |
| `422` | Error de validación del body/query |
| `429` | Rate limit excedido |
| `500` | Error interno o error de AFIP no recuperable |

### 4.1 Autenticación y Estado

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/api/v1/auth/login` | Renovar Token/Sign del WSAA manualmente |

No requiere body. La empresa se identifica por la API Key del header.

**Response:**
```json
{
  "ok": true,
  "token": "...",
  "sign": "...",
  "expira": "2026-07-10T12:00:00"
}
```

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/v1/dummy` | Estado del servicio AFIP (Dummy) |

**Response:**
```json
{
  "ok": true,
  "appserver": "OK",
  "dbserver": "OK",
  "authserver": "OK"
}
```

### 4.2 Facturación

#### `GET /api/v1/factura/ultimo-comprobante`

Query params: `?pto_vta=2&tipo_cbte=6`

**Response:**
```json
{
  "ok": true,
  "ultimo_numero": 420
}
```

#### `POST /api/v1/factura/emitir`

**Request:**
```json
{
  "tipo_cbte": 6,
  "punto_vta": 2,
  "fecha_cbte": "20260410",
  "tipo_doc": 80,
  "nro_doc": 30711479295,
  "condicion_iva_receptor_id": 5,
  "concepto": 1,
  "fecha_serv_desde": null,
  "fecha_serv_hasta": null,
  "fecha_venc_pago": null,
  "imp_total": 121.0,
  "imp_neto": 100.0,
  "imp_iva": 21.0,
  "imp_trib": 0,
  "imp_op_ex": 0,
  "imp_tot_conc": 0,
  "moneda": "PES",
  "moneda_cotizacion": 1,
  "iva": [
    { "id": 5, "base_imp": 100.0, "importe": 21.0 }
  ],
  "tributos": [],
  "comprobante_asociado": null,
  "leyenda": null
}
```

> `condicion_iva_receptor_id` es campo oficial AFIP (wsfev1, obligatorio). Valores comunes: 1=RI, 4=Exento, 5=CF, 6=Monotributo, 9=Cliente del Exterior.

**Campos del comprobante asociado (para NC/ND):**
```json
"comprobante_asociado": {
  "tipo": 11,
  "pto_vta": 2,
  "nro": 420,
  "fecha": "20260410"
}
```

**Campos de leyenda (opcional):**
```json
"leyenda": {
  "id": 1,
  "texto": "RG 1415 - COMPROBANTE VALIDO COMO FACTURA"
}
```

**Response (éxito):**
```json
{
  "ok": true,
  "cae": "64223456789012",
  "vencimiento_cae": "20260710",
  "numero_comprobante": 421,
  "resultado": "A"
}
```

**Response (error):**
```json
{
  "ok": false,
  "error": "Descripción del error",
  "codigo_error": null
}
```

#### `GET /api/v1/factura/consultar`

Query params: `?tipo_cbte=6&pto_vta=2&nro=421`

**Response:**
```json
{
  "ok": true,
  "cae": "64223456789012",
  "vencimiento_cae": "20260710",
  "resultado": "A",
  "fecha_cbte": "20260410",
  "imp_total": 121.0
}
```

### 4.3 Parámetros Auxiliares

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/v1/parametros/tipos-comprobante` | Tipos de comprobante |
| `GET` | `/api/v1/parametros/tipos-documento` | Tipos de documento (80=CUIT, 99=CF) |
| `GET` | `/api/v1/parametros/tipos-iva` | Alícuotas de IVA |
| `GET` | `/api/v1/parametros/cotizacion/:moneda` | Cotización de moneda |
| `GET` | `/api/v1/parametros/puntos-venta` | Puntos de venta habilitados |

**Response genérico:**
```json
{
  "ok": true,
  "datos": [
    { "id": 1, "desc": "Factura A" },
    { "id": 6, "desc": "Factura B" }
  ]
}
```

### 4.4 Health Check

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/v1/health` | Health check del servicio |

**Response:**
```json
{
  "ok": true,
  "uptime": 3600,
  "db": "connected"
}
```

### 4.5 Admin

Rutas de gestión de empresas. Requieren header `X-Admin-Secret: <ADMIN_SECRET>` en lugar de API Key.
No aplica rate limit de empresa (el admin opera fuera del flujo de facturación).

#### `POST /api/v1/admin/empresas`

Registra una nueva empresa. Recibe `multipart/form-data`.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `cuit` | string | CUIT sin guiones (11 dígitos) |
| `razon_social` | string | Razón social |
| `p12` | file | Archivo `.p12` del certificado AFIP |
| `p12_password` | string | Contraseña del `.p12` |

**Response:**
```json
{
  "ok": true,
  "empresa_id": 1,
  "api_key": "a3f9c2d1e4b7..."
}
```

> El servidor cifra el BLOB del `.p12` y la password antes de guardarlos. La `api_key` generada se devuelve una sola vez en esta respuesta — no se puede recuperar luego.

#### `PUT /api/v1/admin/empresas/:id/certificado`

Reemplaza el certificado `.p12` de una empresa existente. Recibe `multipart/form-data`.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `p12` | file | Nuevo archivo `.p12` |
| `p12_password` | string | Contraseña del nuevo `.p12` |

**Response:**
```json
{
  "ok": true
}
```

> Invalida automáticamente el token WSAA cacheado para la empresa (llama a `tokenCache.clear(id)`), forzando re-autenticación en el próximo request.

#### `PATCH /api/v1/admin/empresas/:id`

Activa o desactiva una empresa.

**Request:**
```json
{ "activo": false }
```

**Response:**
```json
{ "ok": true }
```

---

## 5. Middlewares

### auth.js
- Extrae `Authorization: Bearer <api_key>` del header
- Busca `api_key` en tabla `empresas`
- Si no existe o `activo = false`, devuelve 401
- Adjunta `req.empresa` al request (incluye `id`, `cuit`, `p12_data`, `p12_password_encrypted`, `razon_social`)

### rateLimit.js
- Limita requests por API Key usando `express-rate-limit`
- Ventana: 1 segundo / máximo `RATE_LIMIT_RPS` (default: 5)
- `keyGenerator` usa `req.empresa.id` (corre después de `auth.js`)
- Devuelve 429 si se supera el límite

### validate.js
- Usa **Joi** para validar el body/query de cada endpoint
- Define schemas por endpoint (emitir, consultar, etc.)
- Devuelve 422 con detalles si falla validación

### adminAuth.js
- Extrae header `X-Admin-Secret`
- Compara con `ADMIN_SECRET` del `.env` usando comparación en tiempo constante (`crypto.timingSafeEqual`)
- Si no coincide, devuelve 403
- No adjunta `req.empresa` (opera a nivel de servidor, no de empresa)

### errorHandler.js
- Catch-all de errores
- Si es error conocido de AFIP, lo parsea y devuelve mensaje legible
- Loggea a `facturas_log` cuando corresponde
- Devuelve siempre `{ ok: false, error: "..." }`

### Orden de middlewares

```
Rutas normales:  auth.js → rateLimit.js → validate.js → handler → errorHandler.js
Rutas /admin:    adminAuth.js → validate.js → handler → errorHandler.js
```

---

## 6. Servicios

### crypto.js
- `loadP12(p12Buffer, password)` → `{ cert, key, ca }` usando `node-forge` (recibe BLOB desde DB)
- `signCMS(xml, p12Data)` → firma CMS/PKCS#7 en Base64
- `encryptPassword(plain)` → AES-256-GCM con `P12_ENCRYPTION_KEY`
- `decryptPassword(encrypted)` → descifra en memoria para uso en runtime

### wsaa.js
- `obtenerLoginTicketResponse(empresa)` → gestiona cache, llama a WSAA si expiró
- `loginCMS(cmsBase64)` → envía CMS firmado al WSAA, devuelve Token + Sign
- URLs del servicio (sin `?WSDL`, que es solo para consultar el WSDL):
  - Producción: `https://wsaa.afip.gov.ar/ws/services/LoginCms`
  - Homologación: `https://wsaahomo.afip.gov.ar/ws/services/LoginCms`

### wsfev1.js
- `FECompUltimoAutorizado(empresa, ptoVta, tipoCbte)` → último comprobante
- `FECAESolicitar(empresa, requestData)` → emitir comprobante
- `FECompConsultar(empresa, ptoVta, tipoCbte, nro)` → consultar comprobante
- `FEParamGetTiposCbte(empresa)` → tipos de comprobante (y similares para otras tablas)
- `FECotizacionMoneda(empresa, moneda)` → cotización
- `FEDummy()` → estado del servicio (no requiere auth AFIP, pero el endpoint sí requiere API Key)
- URLs:
  - Producción: `https://servicios1.afip.gov.ar/wsfev1/service.asmx`
  - Homologación: `https://wswhomo.afip.gov.ar/wsfev1/service.asmx`

### tokenCache.js
- `get(empresaId)` → busca token vigente en MySQL (`expires_at > NOW()`)
- `set(empresaId, token, sign, expiresAt)` → upsert via `ON DUPLICATE KEY UPDATE`
- `clear(empresaId)` → elimina cache (para renovación forzada)

---

## 7. SOAP y XML

Los servicios de AFIP son ASMX/SOAP. Se implementa:

- **Construcción manual del XML SOAP** usando template strings (los schemas son simples y estables)
- **HTTP POST** con `axios` y content-type `text/xml`
- **SOAP Action** en header según método
- **Namespace**: `http://ar.gov.afip.dif.FEV1/`

No se usa librería SOAP pesada para evitar dependencias frágiles. Cada método tiene su template XML.

---

## 8. Estructura del Proyecto

```
C:\programa\node\hpm-fe\
├── src/
│   ├── index.js                  # Entry point: levanta servidor
│   ├── app.js                    # Express app: middlewares globales, rutas
│   ├── config/
│   │   ├── index.js              # Lee .env, exporta configuración
│   │   └── database.js           # MySQL pool (mysql2/promise)
│   ├── db/
│   │   └── migrations/
│   │       └── 001_schema.sql    # Schema DDL
│   ├── middleware/
│   │   ├── auth.js               # Valida API Key
│   │   ├── adminAuth.js          # Valida X-Admin-Secret
│   │   ├── rateLimit.js          # Rate limit por API Key (express-rate-limit)
│   │   ├── validate.js           # Joi schemas
│   │   └── errorHandler.js       # Error handler global
│   ├── services/
│   │   ├── crypto.js             # node-forge: p12 desde BLOB, PKCS#7, cifrado AES
│   │   ├── wsaa.js               # WSAA autenticación
│   │   ├── wsfev1.js             # Facturación AFIP
│   │   └── tokenCache.js         # Cache MySQL
│   ├── routes/
│   │   ├── auth.js               # POST /auth/login
│   │   ├── factura.js            # Emitir, consultar, último
│   │   ├── consultas.js          # Dummy, health
│   │   ├── parametros.js         # Tablas paramétricas
│   │   └── admin.js              # POST/PUT/PATCH /admin/empresas
│   └── utils/
│       ├── xml.js                # Builders de XML SOAP
│       └── soap.js               # HTTP client para SOAP
├── .env                          # Variables de entorno
├── .env.example                  # Template de .env
├── .gitignore
├── package.json
└── README.md
```

### .env

```
PORT=3000

DB_HOST=localhost
DB_PORT=3306
DB_USER=hpm_fe
DB_PASS=...
DB_NAME=hpm_fe

# Producción:
AFIP_URL=https://servicios1.afip.gov.ar/wsfev1/service.asmx
WSAA_URL=https://wsaa.afip.gov.ar/ws/services/LoginCms

# Homologación (testing):
# AFIP_URL=https://wswhomo.afip.gov.ar/wsfev1/service.asmx
# WSAA_URL=https://wsaahomo.afip.gov.ar/ws/services/LoginCms

P12_ENCRYPTION_KEY=...   # 32 bytes hex para AES-256-GCM

ADMIN_SECRET=...         # Secret para rutas /admin (generar con openssl rand -hex 32)

RATE_LIMIT_RPS=5         # Requests por segundo por API Key
```

### package.json (dependencias)

```json
{
  "dependencies": {
    "express": "^4.18",
    "mysql2": "^3.9",
    "node-forge": "^1.3",
    "joi": "^17.12",
    "axios": "^1.7",
    "express-rate-limit": "^7.4",
    "multer": "^1.4",
    "dotenv": "^16.4"
  }
}
```

---

## 9. Consideraciones de Seguridad

1. **p12 en DB como BLOB**: El `.p12` se almacena cifrado (AES-256-GCM) en la tabla `empresas`. Sin dependencia del filesystem.
2. **Contraseñas cifradas**: La password del p12 se guarda cifrada con la misma clave AES-256-GCM. La clave está en `.env` y nunca en la DB.
3. **API Key en texto plano**: Se genera con `crypto.randomBytes(32).toString('hex')`. Única por empresa. Se almacena en texto plano por simplicidad (decisión consciente).
4. **HTTPS obligatorio**: El servicio debe correr detrás de un reverse proxy (nginx) con TLS.
5. **No loggear secrets**: El middleware de error y `facturas_log` nunca guardan passwords ni contenido de certificados.
6. **Rate limiting**: 5 req/s por API Key por defecto, configurable via `RATE_LIMIT_RPS`.

---

## 10. Próximos Pasos (Plan de Implementación)

1. **Scaffolding**: Inicializar proyecto, package.json, `.env`, `.gitignore`
2. **Base de datos**: Ejecutar migrations, crear pool de conexión
3. **Servicio crypto**: Implementar carga de p12 desde BLOB y firma CMS
4. **Servicio WSAA**: LoginTicketRequest + loginCms + cache
5. **Servicio wsfev1**: Templates SOAP para cada método
6. **Middlewares**: auth, adminAuth, rateLimit, validate, errorHandler
7. **Routes**: Todos los endpoints
8. **Integración**: Probar contra homologación AFIP
9. **Seed**: Script para registrar primera empresa de prueba (carga p12 como BLOB)
