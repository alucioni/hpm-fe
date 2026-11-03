const axios = require('axios');

async function callSoap(url, action, xml) {
  const response = await axios.post(url, xml, {
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': action,
    },
    timeout: 30000,
    // AFIP devuelve HTTP 500 con un <soap:Fault> en el body cuando algo falla;
    // dejamos pasar esos para que el parser extraiga el faultstring legible.
    validateStatus: (status) => status <= 500,
  });
  return response.data;
}

module.exports = { callSoap };
