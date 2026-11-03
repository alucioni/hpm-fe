# Tests de hpm-fe

Tres niveles, del más rápido/aislado al más real:

| Nivel | Carpeta | Necesita | Comando |
|-------|---------|----------|---------|
| **unit** | `test/unit/` | nada (sólo `.env` con `HPM_API_KEY` y `P12_ENCRYPTION_KEY`) | `npm test` |
| **integration** | `test/integration/` | MySQL (`hpm_fe` migrada). AFIP está mockeado. | `npm run test:int` |
| **e2e** | `test/e2e/` | MySQL + empresa emisora **activa** con `.p12` válido + `.env` en homologación | `RUN_E2E=1 npm run test:e2e` |
| **prod** | `test/prod/` | MySQL + empresa **de producción** activa + URLs de producción | `node test/prod/prod-smoke.mjs` (ver abajo) |

`npm run test:all` = unit + integration. `test/prod/` NO entra en ningún `npm run test*` — se corre a mano.

Runner: `node --test` nativo (Node 18+). Sin dependencias nuevas.

## unit

Puro, sin red ni DB. Se saltan solos si faltan las claves del `.env`.

- `validate.test.js` — schemas Joi de `middleware/validate.js` (emitir, ultimoComprobante, consultar, patchEmpresa): requeridos, formatos, defaults, `stripUnknown`, reglas condicionales por `concepto`.
- `crypto.test.js` — `encryptPassword`/`decryptPassword` (AES-256-GCM): round-trip, IV aleatorio, detección de manipulación.
- `xml.test.js` — builders SOAP de `utils/xml.js`: estructura, `CondicionIVAReceptorId`, importes a 2 decimales, Iva/Tributos condicionales, comprobante asociado, leyenda, `parseXml`.
- `auth.test.js` — `middleware/auth.js`: 401 sin header / esquema inválido / key incorrecta (igual y distinta longitud), `next()` con la key correcta.

## integration

Levanta la app real en un puerto efímero, usa **MySQL real** y **mockea `services/wsfev1`** (no toca AFIP).

Crea una empresa descartable (`cuit 30000000001`) en `before` y la borra en `after` (CASCADE limpia `token_cache`, `facturas_log`, `emisiones_idempotencia`).

Cubre: `health`; 401 sin/mal Authorization; 422 sin `cuit_emisor` / CUIT inexistente; `emitir` OK + persistencia en `facturas_log` y `emisiones_idempotencia` (`estado='listo'`); reintento con misma clave sin re-llamar a AFIP; body inválido → 422; **concurrencia** con misma clave → una 200 y otra 409; `consultar`; **rate limit** (ráfaga > `RATE_LIMIT_RPS` → 429).

Si MySQL no responde, toda la suite se salta con un mensaje.

## e2e

Flujo real contra **AFIP homologación**. No corre sin `RUN_E2E=1`. Consume numeración de comprobantes de homologación.

Prerrequisitos:
1. `.env` con `AFIP_URL`/`WSAA_URL` de homologación (`wswhomo` / `wsaahomo`).
2. MySQL con la empresa emisora cargada y `activo=1`, `.p12` válido.
3. Variables opcionales: `E2E_CUIT` (def. `30714794295`), `E2E_PTO_VTA` (1), `E2E_TIPO_CBTE` (6 = Factura B), `E2E_TIPO_DOC` (99), `E2E_NRO_DOC` (0), `E2E_COND_IVA` (5).

```powershell
# PowerShell
$env:RUN_E2E=1; npm run test:e2e
```
```bash
# bash
RUN_E2E=1 npm run test:e2e
```

Pasos: `health` → `dummy` (servicio AFIP OK) → 401 sin auth → `auth/login` (token+sign+expira) → `ultimo-comprobante` → `emitir` (CAE de 14 dígitos, `resultado='A'`) → reintento con misma clave (mismo CAE) → `consultar` el comprobante → body inválido → 422 → post-condición en DB (`emisiones_idempotencia.estado='listo'`).

Si la empresa está inactiva o no cargada, la suite se salta indicando el motivo.

## prod — validación contra AFIP PRODUCCIÓN

Scripts sueltos (no `node --test`), para validar el circuito productivo con un `.p12` real.

### Prerrequisitos AFIP (CUIT real)
1. **Certificado de producción** generado con clave fiscal (CSR → "Certificados Digitales"). Es otro cert, distinto del de homologación.
2. **"Administrador de Relaciones de Clave Fiscal"**: adherir *Facturación Electrónica* (`wsfe`) y delegar el servicio al certificado. Si factura un representado, la delegación va de ese CUIT al dueño del cert.
3. **Punto de venta** habilitado para Web Services.

### Cargar la empresa de producción
Con el server levantado (`npm start`):
```bash
curl -X POST http://127.0.0.1:3000/api/v1/admin/empresas \
  -H "X-Admin-Secret: <ADMIN_SECRET del .env>" \
  -F cuit=<CUIT> -F razon_social="<RS>" \
  -F p12=@C:/ruta/cert_produccion.p12 -F p12_password="<pass>"
```
Guardá el `api_key` y `empresa_id` que devuelve. Si el CUIT ya existe (p. ej. la de homologación):
`curl -X PUT http://127.0.0.1:3000/api/v1/admin/empresas/<id>/certificado -H "X-Admin-Secret: ..." -F p12=@... -F p12_password="..."`
(esto además limpia el token cacheado).

### 1. `prod-smoke.mjs` — READ-ONLY, no emite nada
Ejercita firma CMS + WSAA + punto de venta + parseo SOAP contra producción sin generar comprobantes.
```powershell
$env:AFIP_URL="https://servicios1.afip.gov.ar/wsfev1/service.asmx"
$env:WSAA_URL="https://wsaa.afip.gov.ar/ws/services/LoginCms"
$env:PROD_CUIT="30xxxxxxxx9"
$env:PROD_PTO_VTA="3"          # default 1
$env:PROD_TIPO_CBTE="6"        # default 6 (Factura B)
$env:PROD_NRO="123"            # opcional: consulta ese comprobante
node test/prod/prod-smoke.mjs
```
Chequea: `dummy` → `auth/login` (cert + delegación) → `puntos-venta` (valida que `PROD_PTO_VTA` esté habilitado) → `ultimo-comprobante` → `consultar` (si hay `PROD_NRO`). Exit != 0 si algo falla.

Las variables `AFIP_URL`/`WSAA_URL` seteadas en el entorno pisan al `.env` (dotenv no las sobrescribe), así que no hace falta editar `.env`.

### 2. Emitir comprobante fiscal REAL de prueba
**Documentos fiscales reales.** Gate obligatorio `EMITIR_REAL=SI`. Corré `prod-smoke.mjs` primero.

El tipo de comprobante depende del régimen del emisor (lo ves en `puntos-venta`):
- **Monotributo** → `prod-emitir-fcc.mjs` — Factura C (11) + NC C (13), sin IVA discriminado.
- **Responsable Inscripto** → `prod-emitir-fcb.mjs` — Factura B (6) + NC B (8), con IVA 21%.

```powershell
$env:AFIP_URL="https://servicios1.afip.gov.ar/wsfev1/service.asmx"
$env:WSAA_URL="https://wsaa.afip.gov.ar/ws/services/LoginCms"
$env:PROD_CUIT="20219547006"; $env:PROD_PTO_VTA="2"
$env:EMITIR_REAL="SI"
$env:NC="NO"        # opcional: no emite la nota de crédito de anulación
node test/prod/prod-emitir-fcc.mjs
```
Emite $1,21 (configurable con `PROD_IMPORTE`) y, salvo `NC=NO`, la NC asociada que la anula.
