const crypto = require('crypto');
const forge = require('node-forge');
const config = require('../config');

function encryptPassword(plain) {
  const key = Buffer.from(config.p12EncryptionKey, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptPassword(encryptedStr) {
  const key = Buffer.from(config.p12EncryptionKey, 'hex');
  const [ivHex, tagHex, dataHex] = encryptedStr.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function loadP12(p12Buffer, password) {
  const p12Der = forge.util.createBuffer(p12Buffer.toString('binary'));
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);

  let cert = null;
  let privateKey = null;

  for (const safeContents of p12.safeContents) {
    for (const bag of safeContents.safeBags) {
      if (bag.type === forge.pki.oids.certBag && !cert) {
        cert = bag.cert;
      }
      if (bag.type === forge.pki.oids.pkcs8ShroudedKeyBag && !privateKey) {
        privateKey = bag.key;
      }
    }
  }

  if (!cert || !privateKey) throw new Error('p12 inválido: no se encontró certificado o clave privada');
  return { cert, privateKey };
}

function signCMS(xml, p12Buffer, password) {
  const { cert, privateKey } = loadP12(p12Buffer, password);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(xml, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key: privateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign();

  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return Buffer.from(der, 'binary').toString('base64');
}

function getCertInfo(p12Buffer, password) {
  const { cert } = loadP12(p12Buffer, password);
  return {
    subject: cert.subject.attributes.map((a) => `${a.shortName}=${a.value}`).join(', '),
    validFrom: cert.validity.notBefore,
    validTo: cert.validity.notAfter,
  };
}

module.exports = { encryptPassword, decryptPassword, signCMS, getCertInfo };
