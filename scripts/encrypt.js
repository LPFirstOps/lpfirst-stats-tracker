/**
 * Encryption script for the contractor stats dashboard.
 *
 * Usage: npm run encrypt (uses STATICRYPT_PASSWORD from .env)
 *
 * This script:
 * 1. Encrypts data/stats.json → data/stats.json.enc
 * 2. Modifies index.html to decrypt data/stats.json.enc client-side
 * 3. Encrypts index.html with StatiCrypt (password prompt)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto').webcrypto;

const ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'index.html');
const INDEX_BAK_PATH = path.join(ROOT, 'index.html.bak');
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

function generateRandomSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(128 / 8));
  return HexEncoder.stringify(new Uint8Array(bytes));
}

function loadOrCreateConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    console.log('Loaded salt from .staticrypt.json');
    return config;
  }
  const config = { salt: generateRandomSalt() };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log('Generated new salt and saved to .staticrypt.json');
  return config;
}

async function main() {
  const password = process.env.STATICRYPT_PASSWORD;
  if (!password) {
    console.error('Error: STATICRYPT_PASSWORD environment variable is required');
    console.error('Add STATICRYPT_PASSWORD=your-password to your .env file');
    process.exit(1);
  }

  // Check that stats.json exists
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`Error: ${DATA_PATH} not found. Run the scraper first.`);
    process.exit(1);
  }

  // Load or create salt
  const config = loadOrCreateConfig();
  const salt = config.salt;

  console.log('Hashing password with PBKDF2 (600k iterations)...');
  const hashedPassword = await hashPassword(password, salt);

  // Encrypt the data file
  console.log('Encrypting data/stats.json...');
  const dataContent = fs.readFileSync(DATA_PATH, 'utf8');
  const encryptedData = await encrypt(dataContent, hashedPassword);
  fs.writeFileSync(DATA_ENC_PATH, encryptedData);
  console.log(`Created ${DATA_ENC_PATH}`);

  // Restore original index.html from backup if it exists
  if (fs.existsSync(INDEX_BAK_PATH)) {
    fs.copyFileSync(INDEX_BAK_PATH, INDEX_PATH);
    console.log('Restored index.html from backup');
  } else {
    // Create backup
    fs.copyFileSync(INDEX_PATH, INDEX_BAK_PATH);
    console.log('Created index.html.bak');
  }

  // Read original index.html
  let indexHtml = fs.readFileSync(INDEX_PATH, 'utf8');

  // Inject the salt and crypto engine into index.html (before </head>)
  const cryptoScript = `
  <script>
    // Salt for StatiCrypt decryption
    window.STATICRYPT_SALT = "${salt}";

    // StatiCrypt-compatible crypto engine for decrypting data
    window.cryptoEngine = (function() {
      const IV_BITS = 16 * 8;
      const HEX_BITS = 4;
      const ENCRYPTION_ALGO = 'AES-CBC';

      const HexEncoder = {
        parse: function(hexString) {
          if (hexString.length % 2 !== 0) throw 'Invalid hexString';
          const arrayBuffer = new Uint8Array(hexString.length / 2);
          for (let i = 0; i < hexString.length; i += 2) {
            const byteValue = parseInt(hexString.substring(i, i + 2), 16);
            if (isNaN(byteValue)) throw 'Invalid hexString';
            arrayBuffer[i / 2] = byteValue;
          }
          return arrayBuffer;
        },
        stringify: function(bytes) {
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
        parse: function(str) { return new TextEncoder().encode(str); },
        stringify: function(bytes) { return new TextDecoder().decode(bytes); }
      };

      async function decrypt(encryptedMsg, hashedPassword) {
        const ivLength = IV_BITS / HEX_BITS;
        const iv = HexEncoder.parse(encryptedMsg.substring(0, ivLength));
        const encrypted = encryptedMsg.substring(ivLength);
        const key = await crypto.subtle.importKey('raw', HexEncoder.parse(hashedPassword), ENCRYPTION_ALGO, false, ['decrypt']);
        const outBuffer = await crypto.subtle.decrypt({ name: ENCRYPTION_ALGO, iv }, key, HexEncoder.parse(encrypted));
        return UTF8Encoder.stringify(new Uint8Array(outBuffer));
      }

      return { decrypt };
    })();
  </script>
`;

  indexHtml = indexHtml.replace('</head>', `${cryptoScript}</head>`);

  // Replace the loadData function with one that decrypts the encrypted data
  const newLoadDataFunction = `async function loadData() {
      showLoading(true);
      try {
        // Get the hashed password from localStorage (stored by StatiCrypt)
        const hashedPassword = localStorage.getItem('staticrypt_passphrase');
        if (!hashedPassword) {
          console.error('No password found in localStorage');
          showNoData(true);
          return;
        }

        // Fetch the encrypted data file
        const response = await fetch('./data/stats.json.enc');
        if (!response.ok) throw new Error('Failed to load encrypted data');
        const encryptedData = await response.text();

        // Decrypt using the hashed password from StatiCrypt
        const decryptedJson = await window.cryptoEngine.decrypt(encryptedData, hashedPassword);
        statsData = JSON.parse(decryptedJson);

        if (!statsData.years || Object.keys(statsData.years).length === 0) {
          showNoData(true);
          return;
        }

        showNoData(false);
        populatePomTypeFilter();
        updateSummaryCards();
        createAllCharts();
        updateAllTables();
        updateDataTable();

        if (statsData.lastUpdated) {
          document.getElementById('lastUpdated').textContent =
            'Last updated: ' + new Date(statsData.lastUpdated).toLocaleString();
        }
      } catch (error) {
        console.error('Error loading data:', error);
        showNoData(true);
      } finally {
        showLoading(false);
      }
    }`;

  // Replace the existing loadData function using a more robust regex
  indexHtml = indexHtml.replace(
    /async function loadData\(\) \{[\s\S]*?showLoading\(false\);\s*\}\s*\}/,
    newLoadDataFunction
  );

  // Write the modified index.html
  fs.writeFileSync(INDEX_PATH, indexHtml);
  console.log('Modified index.html with crypto engine and encrypted data loading');

  // Run StatiCrypt CLI to encrypt index.html with custom styling
  // Use default output directory (encrypted/) so we can modify it before final placement
  console.log('Running StatiCrypt to encrypt index.html...');
  try {
    execSync(
      `npx staticrypt index.html -p "${password}" --short --remember 30 ` +
      `--template-title "" ` +
      `--template-instructions "Enter your password to access the dashboard." ` +
      `--template-color-primary "#02245f" ` +
      `--template-color-secondary "#02245f"`,
      { cwd: ROOT, stdio: 'inherit' }
    );
  } catch (error) {
    console.error('StatiCrypt encryption failed:', error.message);
    process.exit(1);
  }

  // StatiCrypt creates encrypted/index.html, we add the logo and move it
  const encryptedIndexPath = path.join(ROOT, 'encrypted', 'index.html');
  if (fs.existsSync(encryptedIndexPath)) {
    let encryptedHtml = fs.readFileSync(encryptedIndexPath, 'utf8');

    // Add the logo above the title in the form
    const logoHtml = `<img src="./images/lpfirst.webp" alt="LP First Capital" style="max-width: 200px; margin-bottom: 20px;" />`;
    encryptedHtml = encryptedHtml.replace(
      '<p class="staticrypt-title">',
      `${logoHtml}<p class="staticrypt-title">`
    );

    // IMPORTANT: Modify StatiCrypt to ALWAYS store the password in localStorage
    // (not just when "Remember me" is checked) so our dashboard can decrypt the data file
    encryptedHtml = encryptedHtml.replace(
      'if (isRememberEnabled && isRememberChecked) {',
      'if (isRememberEnabled) { // Always store password for data decryption'
    );

    fs.writeFileSync(INDEX_PATH, encryptedHtml);
    fs.rmSync(path.join(ROOT, 'encrypted'), { recursive: true });
    console.log('Added logo and modified password storage');
  } else {
    console.error('Warning: encrypted/index.html not found after StatiCrypt');
  }

  // Clean up: delete unencrypted stats.json (stats.json.enc is the source of truth)
  if (fs.existsSync(DATA_PATH)) {
    fs.unlinkSync(DATA_PATH);
    console.log('Cleaned up data/stats.json (stats.json.enc is source of truth)');
  }

  console.log('\n✓ Encryption complete!');
  console.log('  - index.html is now encrypted (password prompt)');
  console.log('  - data/stats.json.enc contains encrypted data (source of truth)');
  console.log('  - Original index.html is backed up to index.html.bak');
  console.log('\nTo test: npm run serve');
}

main().catch(err => {
  console.error('Encryption failed:', err);
  process.exit(1);
});
