import forge from 'node-forge';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sslDir = path.join(__dirname, '.ssl');
if (!fs.existsSync(sslDir)) fs.mkdirSync(sslDir);

const keys = forge.pki.rsa.generateKeyPair(2048);
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = Date.now().toString(16);
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

const attrs = [
  { name: 'commonName', value: 'ACP UI Local Dev' },
  { name: 'organizationName', value: 'ACP UI' }
];

cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.setExtensions([
  { name: 'basicConstraints', cA: true },
  { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
  { name: 'extKeyUsage', serverAuth: true },
  {
    name: 'subjectAltName',
    altNames: [
      { type: 2, value: 'localhost' },
      { type: 7, ip: '127.0.0.1' }
    ]
  }
]);

cert.sign(keys.privateKey, forge.md.sha256.create());

const pemCert = forge.pki.certificateToPem(cert);
const pemKey = forge.pki.privateKeyToPem(keys.privateKey);

fs.writeFileSync(path.join(sslDir, 'cert.pem'), pemCert);
fs.writeFileSync(path.join(sslDir, 'key.pem'), pemKey);

console.log('SSL certificates generated in .ssl/');
console.log('  Valid for: 10 years');
console.log('  SAN: localhost, 127.0.0.1');

// Auto-trust on Windows
const certPath = path.join(sslDir, 'cert.pem');
try {
  execSync(`certutil -addstore -user -f "Root" "${certPath}"`, { stdio: 'pipe' });
  console.log('\n✅ Certificate added to system trusted root store.');
  console.log('   Chrome will trust it without warnings after restart.');
} catch (_err) {
  console.log('\n⚠️  Could not auto-trust certificate. To trust manually:');
  console.log(`   certutil -addstore -user -f "Root" "${certPath}"`);
}
