const xml2js = require('xml2js');

function toAfipDate(date) {
  // Convierte Date a formato ISO con offset Argentina UTC-3
  const d = new Date(date.getTime() - 3 * 3600000);
  return d.toISOString().slice(0, 19) + '-03:00';
}

function parseXml(xml) {
  return xml2js.parseStringPromise(xml, {
    explicitArray: false,
    ignoreAttrs: true,
    tagNameProcessors: [xml2js.processors.stripPrefix],
  });
}

function buildLoginTicketRequest(service = 'wsfe') {
  const now = new Date();
  const gen = new Date(now.getTime() - 10 * 60000);
  const exp = new Date(now.getTime() + 12 * 3600000 - 10 * 60000);
  const uniqueId = Math.floor(now.getTime() / 1000);

  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${uniqueId}</uniqueId>
    <generationTime>${toAfipDate(gen)}</generationTime>
    <expirationTime>${toAfipDate(exp)}</expirationTime>
  </header>
  <service>${service}</service>
</loginTicketRequest>`;
}

function buildLoginCmsSoap(cmsBase64) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:log="http://wsaa.view.sua.dvadac.desein.afip.gov.ar/">
  <soapenv:Header/>
  <soapenv:Body>
    <log:loginCms>
      <log:in0>${cmsBase64}</log:in0>
    </log:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function buildAuth(token, sign, cuit) {
  return `<ar:Auth>
        <ar:Token>${token}</ar:Token>
        <ar:Sign>${sign}</ar:Sign>
        <ar:Cuit>${cuit}</ar:Cuit>
      </ar:Auth>`;
}

function buildFEDummySoap() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">
  <soapenv:Header/>
  <soapenv:Body>
    <ar:FEDummy/>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function buildFECompUltimoAutorizadoSoap(token, sign, cuit, ptoVta, tipoCbte) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">
  <soapenv:Header/>
  <soapenv:Body>
    <ar:FECompUltimoAutorizado>
      ${buildAuth(token, sign, cuit)}
      <ar:PtoVta>${ptoVta}</ar:PtoVta>
      <ar:CbteTipo>${tipoCbte}</ar:CbteTipo>
    </ar:FECompUltimoAutorizado>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function buildFECAESolicitarSoap(token, sign, cuit, data, cbteNro) {
  const ivaXml = data.iva && data.iva.length > 0
    ? `<ar:Iva>${data.iva.map(a => `
          <ar:AlicIva>
            <ar:Id>${a.id}</ar:Id>
            <ar:BaseImp>${Number(a.base_imp).toFixed(2)}</ar:BaseImp>
            <ar:Importe>${Number(a.importe).toFixed(2)}</ar:Importe>
          </ar:AlicIva>`).join('')}
        </ar:Iva>`
    : '';

  const tributosXml = data.tributos && data.tributos.length > 0
    ? `<ar:Tributos>${data.tributos.map(t => `
          <ar:Tributo>
            <ar:Id>${t.id}</ar:Id>
            <ar:Desc>${t.desc}</ar:Desc>
            <ar:BaseImp>${Number(t.base_imp).toFixed(2)}</ar:BaseImp>
            <ar:Alic>${Number(t.alic).toFixed(2)}</ar:Alic>
            <ar:Importe>${Number(t.importe).toFixed(2)}</ar:Importe>
          </ar:Tributo>`).join('')}
        </ar:Tributos>`
    : '';

  const serviciosXml = data.concepto !== 1 && data.fecha_serv_desde
    ? `<ar:FchServDesde>${data.fecha_serv_desde}</ar:FchServDesde>
          <ar:FchServHasta>${data.fecha_serv_hasta}</ar:FchServHasta>
          <ar:FchVtoPago>${data.fecha_venc_pago}</ar:FchVtoPago>`
    : '';

  const cbteAsocXml = data.comprobante_asociado
    ? `<ar:CbtesAsoc>
          <ar:CbteAsoc>
            <ar:Tipo>${data.comprobante_asociado.tipo}</ar:Tipo>
            <ar:PtoVta>${data.comprobante_asociado.pto_vta}</ar:PtoVta>
            <ar:Nro>${data.comprobante_asociado.nro}</ar:Nro>
            <ar:Cuit>${cuit}</ar:Cuit>
            <ar:CbteFch>${data.comprobante_asociado.fecha}</ar:CbteFch>
          </ar:CbteAsoc>
        </ar:CbtesAsoc>`
    : '';

  const leyendaXml = data.leyenda
    ? `<ar:Opcionales>
          <ar:Opcional>
            <ar:Id>${data.leyenda.id}</ar:Id>
            <ar:Valor>${data.leyenda.texto}</ar:Valor>
          </ar:Opcional>
        </ar:Opcionales>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">
  <soapenv:Header/>
  <soapenv:Body>
    <ar:FECAESolicitar>
      ${buildAuth(token, sign, cuit)}
      <ar:FeCAEReq>
        <ar:FeCabReq>
          <ar:CantReg>1</ar:CantReg>
          <ar:PtoVta>${data.punto_vta}</ar:PtoVta>
          <ar:CbteTipo>${data.tipo_cbte}</ar:CbteTipo>
        </ar:FeCabReq>
        <ar:FeDetReq>
          <ar:FECAEDetRequest>
            <ar:Concepto>${data.concepto}</ar:Concepto>
            <ar:DocTipo>${data.tipo_doc}</ar:DocTipo>
            <ar:DocNro>${data.nro_doc}</ar:DocNro>
            <ar:CbteDesde>${cbteNro}</ar:CbteDesde>
            <ar:CbteHasta>${cbteNro}</ar:CbteHasta>
            <ar:CbteFch>${data.fecha_cbte}</ar:CbteFch>
            <ar:ImpTotal>${Number(data.imp_total).toFixed(2)}</ar:ImpTotal>
            <ar:ImpTotConc>${Number(data.imp_tot_conc || 0).toFixed(2)}</ar:ImpTotConc>
            <ar:ImpNeto>${Number(data.imp_neto).toFixed(2)}</ar:ImpNeto>
            <ar:ImpOpEx>${Number(data.imp_op_ex || 0).toFixed(2)}</ar:ImpOpEx>
            <ar:ImpTrib>${Number(data.imp_trib || 0).toFixed(2)}</ar:ImpTrib>
            <ar:ImpIVA>${Number(data.imp_iva || 0).toFixed(2)}</ar:ImpIVA>
            ${serviciosXml}
            <ar:MonId>${data.moneda}</ar:MonId>
            <ar:MonCotiz>${data.moneda_cotizacion}</ar:MonCotiz>
            <ar:CondicionIVAReceptorId>${data.condicion_iva_receptor_id}</ar:CondicionIVAReceptorId>
            ${ivaXml}
            ${tributosXml}
            ${cbteAsocXml}
            ${leyendaXml}
          </ar:FECAEDetRequest>
        </ar:FeDetReq>
      </ar:FeCAEReq>
    </ar:FECAESolicitar>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function buildFECompConsultarSoap(token, sign, cuit, ptoVta, tipoCbte, nro) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">
  <soapenv:Header/>
  <soapenv:Body>
    <ar:FECompConsultar>
      ${buildAuth(token, sign, cuit)}
      <ar:FeCompConsReq>
        <ar:CbteTipo>${tipoCbte}</ar:CbteTipo>
        <ar:CbteNro>${nro}</ar:CbteNro>
        <ar:PtoVta>${ptoVta}</ar:PtoVta>
      </ar:FeCompConsReq>
    </ar:FECompConsultar>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function buildParamSoap(method, token, sign, cuit, extra = '') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">
  <soapenv:Header/>
  <soapenv:Body>
    <ar:${method}>
      ${buildAuth(token, sign, cuit)}
      ${extra}
    </ar:${method}>
  </soapenv:Body>
</soapenv:Envelope>`;
}

module.exports = {
  parseXml,
  buildLoginTicketRequest,
  buildLoginCmsSoap,
  buildFEDummySoap,
  buildFECompUltimoAutorizadoSoap,
  buildFECAESolicitarSoap,
  buildFECompConsultarSoap,
  buildParamSoap,
};
