/**
 * Capture the CA/intermediate chain that the corporate SSL-intercepting proxy
 * presents for binaries.prisma.sh, and write it to corp-ca.pem.
 *
 * This does ONE unverified TLS handshake purely to READ the chain the proxy
 * offers (we do not send or trust any data over it). The resulting PEM is then
 * used as NODE_EXTRA_CA_CERTS so the real Prisma download verifies normally.
 *
 * Hướng B: we keep certificate verification ON for the actual download; we only
 * teach Node about the corporate root, we do not disable checking.
 */
import tls from 'node:tls';
import { writeFileSync } from 'node:fs';

const HOST = 'binaries.prisma.sh';
const PORT = 443;

const socket = tls.connect(
  { host: HOST, port: PORT, servername: HOST, rejectUnauthorized: false },
  () => {
    const pems = [];
    let cert = socket.getPeerCertificate(true);
    const seen = new Set();
    while (cert && cert.raw && !seen.has(cert.fingerprint256)) {
      seen.add(cert.fingerprint256);
      const b64 = cert.raw.toString('base64').match(/.{1,64}/g).join('\n');
      pems.push(
        `# Subject: ${cert.subject?.CN ?? JSON.stringify(cert.subject)}\n` +
          `# Issuer:  ${cert.issuer?.CN ?? JSON.stringify(cert.issuer)}\n` +
          `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----`,
      );
      if (cert.issuerCertificate && cert.issuerCertificate !== cert) {
        cert = cert.issuerCertificate;
      } else {
        break;
      }
    }
    writeFileSync('corp-ca.pem', pems.join('\n') + '\n');
    console.log(`WROTE ${pems.length} cert(s) to corp-ca.pem`);
    socket.end();
  },
);

socket.on('error', (e) => {
  console.error('TLS_ERROR', e.message);
  process.exit(1);
});
