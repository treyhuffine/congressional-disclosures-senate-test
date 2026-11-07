// Raw response artifacts are encrypted before leaving the ephemeral runner.
const fs = require('node:fs');
const crypto = require('node:crypto');
const MAGIC = Buffer.from('SENATE1\0');

function encrypt(plaintext, key) {
  if (key.length !== 32 || plaintext.length > 32 * 1024 * 1024) throw Error('Encryption bounds failed');
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
}
function decrypt(envelope, key) {
  if (!envelope.subarray(0, 8).equals(MAGIC)) throw Error('Unknown envelope');
  const cipher = crypto.createDecipheriv('aes-256-gcm', key, envelope.subarray(8, 20));
  cipher.setAuthTag(envelope.subarray(20, 36));
  return Buffer.concat([cipher.update(envelope.subarray(36)), cipher.final()]);
}
module.exports = { encrypt, decrypt };
if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  const key = Buffer.from(process.env.SENATE_EVIDENCE_KEY || '', 'base64');
  try {
    const ciphertext = encrypt(fs.readFileSync(input), key);
    fs.writeFileSync(output, ciphertext);
    console.log(JSON.stringify({ encrypted_artifact_bytes: ciphertext.length,
      ciphertext_sha256: crypto.createHash('sha256').update(ciphertext).digest('hex') }));
  } finally { key.fill(0); }
}
