/**
 * Decryption script for the contractor stats data.
 *
 * Usage: npm run decrypt (uses STATICRYPT_PASSWORD from .env)
 *
 * Decrypts data/stats.json.enc → data/stats.json so the scraper can update it.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto').webcrypto;

const ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'data', 'stats.json');
const DATA_ENC_PATH = path.join(ROOT, 'data', 'stats.json.enc');
const CONFIG_PATH = path.join(ROOT, '.staticrypt.json');

// Crypto constants (matching StatiCrypt)
const IV_BITS = 16 * 8;
const HEX_BITS = 4;
const ENCRYPTION_ALGO = 'AES-CBC';

// Hex encoder utilities
const HexEncoder = {
  parse(hexString) {
    if (hexString.length % 2 !== 0) throw new Error('Invalid hexString');
    const arrayBuffer = new Uint8Array(hexString.length / 2);
    for (let i = 0; i < hexString.length; i += 2) {
      const byteValue = parseInt(hexString.substring(i, i + 2), 16);
      if (isNaN(byteValue)) throw new Error('Invalid hexString');
      arrayBuffer[i / 2] = byteValue;
    }
    return arrayBuffer;
  },
  stringify(bytes) {
    const hexBytes = [];
    for (let i = 0; i < bytes.length; ++i) {
      let byteString = bytes[i].toString(16);
      if (byteString.length < 2) byteString = '0' + byteString;
      hexBytes.push(byteString);
    }
    return hexBytes.join('');
  }
};

const UTF8Encoder = {
  parse(str) { return new TextEncoder().encode(str); },
  stringify(bytes) { return new TextDecoder().decode(bytes); }
};

// PBKDF2 hashing (matching StatiCrypt's 600k iterations)
async function pbkdf2(password, salt, iterations, hashAlgorithm) {
  const key = await crypto.subtle.importKey('raw', UTF8Encoder.parse(password), 'PBKDF2', false, ['deriveBits']);
  const keyBytes = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: hashAlgorithm,
    iterations,
    salt: UTF8Encoder.parse(salt)
  }, key, 256);
  return HexEncoder.stringify(new Uint8Array(keyBytes));
}

async function hashPassword(password, salt) {
  let hashedPassword = await pbkdf2(password, salt, 1000, 'SHA-1');
  hashedPassword = await pbkdf2(hashedPassword, salt, 14000, 'SHA-256');
  return pbkdf2(hashedPassword, salt, 585000, 'SHA-256');
}

async function decrypt(encryptedMsg, hashedPassword) {
  const ivLength = IV_BITS / HEX_BITS;
  const iv = HexEncoder.parse(encryptedMsg.substring(0, ivLength));
  const encrypted = encryptedMsg.substring(ivLength);
  const key = await crypto.subtle.importKey('raw', HexEncoder.parse(hashedPassword), ENCRYPTION_ALGO, false, ['decrypt']);
  const outBuffer = await crypto.subtle.decrypt({ name: ENCRYPTION_ALGO, iv }, key, HexEncoder.parse(encrypted));
  return UTF8Encoder.stringify(new Uint8Array(outBuffer));
}

async function main() {
  const password = process.env.STATICRYPT_PASSWORD;
  if (!password) {
    console.error('Error: STATICRYPT_PASSWORD environment variable is required');
    process.exit(1);
  }

  // Check if encrypted file exists
  if (!fs.existsSync(DATA_ENC_PATH)) {
    console.log('No encrypted data file found (data/stats.json.enc)');
    console.log('This is normal for initial setup - scraper will create stats.json');
    process.exit(0);
  }

  // Load salt
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('Error: .staticrypt.json not found. Cannot decrypt without salt.');
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const salt = config.salt;

  console.log('Hashing password with PBKDF2 (600k iterations)...');
  const hashedPassword = await hashPassword(password, salt);

  console.log('Decrypting data/stats.json.enc...');
  const encryptedData = fs.readFileSync(DATA_ENC_PATH, 'utf8');

  try {
    const decryptedData = await decrypt(encryptedData, hashedPassword);

    // Validate it's valid JSON
    JSON.parse(decryptedData);

    fs.writeFileSync(DATA_PATH, decryptedData);
    console.log('✓ Decrypted to data/stats.json');
  } catch (error) {
    console.error('Decryption failed:', error.message);
    console.error('Check that STATICRYPT_PASSWORD is correct');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Decryption failed:', err);
  process.exit(1);
});
