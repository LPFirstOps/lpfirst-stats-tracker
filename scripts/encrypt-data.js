/**
 * Data-only encryption script for daily updates.
 *
 * Usage: npm run encrypt:data (uses STATICRYPT_PASSWORD from .env)
 *
 * This script ONLY encrypts data/stats.json → data/stats.json.enc
 * It does NOT modify index.html (use encrypt.js for full encryption)
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
  // Round 1: 1000 iterations with SHA-1
  let hashedPassword = await pbkdf2(password, salt, 1000, 'SHA-1');
  // Round 2: 14000 iterations with SHA-256
  hashedPassword = await pbkdf2(hashedPassword, salt, 14000, 'SHA-256');
  // Round 3: 585000 iterations with SHA-256
  return pbkdf2(hashedPassword, salt, 585000, 'SHA-256');
}

async function encrypt(msg, hashedPassword) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BITS / 8));
  const key = await crypto.subtle.importKey('raw', HexEncoder.parse(hashedPassword), ENCRYPTION_ALGO, false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: ENCRYPTION_ALGO, iv }, key, UTF8Encoder.parse(msg));
  return HexEncoder.stringify(iv) + HexEncoder.stringify(new Uint8Array(encrypted));
}

async function main() {
  const password = process.env.STATICRYPT_PASSWORD;
  if (!password) {
    console.error('Error: STATICRYPT_PASSWORD environment variable is required');
    process.exit(1);
  }

  // Check that stats.json exists
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`Error: ${DATA_PATH} not found. Run the scraper first.`);
    process.exit(1);
  }

  // Load salt from config (must exist from initial encrypt)
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('Error: .staticrypt.json not found. Run npm run encrypt first.');
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const salt = config.salt;

  console.log('Hashing password with PBKDF2 (600k iterations)...');
  const hashedPassword = await hashPassword(password, salt);

  // Encrypt the data file
  console.log('Encrypting data/stats.json...');
  const dataContent = fs.readFileSync(DATA_PATH, 'utf8');
  const encryptedData = await encrypt(dataContent, hashedPassword);
  fs.writeFileSync(DATA_ENC_PATH, encryptedData);

  // Clean up unencrypted stats.json
  fs.unlinkSync(DATA_PATH);

  console.log('✓ Data encrypted to data/stats.json.enc');
}

main().catch(err => {
  console.error('Encryption failed:', err);
  process.exit(1);
});
