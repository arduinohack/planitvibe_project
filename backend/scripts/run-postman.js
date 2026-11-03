'use strict';

const path = require('path');
const readline = require('readline');
const newman = require('newman');
const dotenv = require('dotenv');

const root = path.join(__dirname, '..');
dotenv.config({ path: path.join(root, '.env') });
const environmentPath = path.join(root, 'postman', 'PlanItVibe.local.postman_environment.json');
const collectionPath = path.join(root, 'postman', 'PlanItVibe.postman_collection.json');

function envValue(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value : '';
}

function readPassword(promptLabel) {
  return new Promise((resolve) => {
    process.stdout.write(promptLabel);

    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
      });
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        rl.close();
        process.stdout.write('\n');
        resolve(value);
      };
      rl.once('line', finish);
      rl.once('close', () => finish(''));
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let password = '';
    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    const onData = (chunk) => {
      const text = String(chunk);
      if (text.includes('\u0003')) {
        cleanup();
        process.stdout.write('\n');
        process.exit(1);
      }
      if (text.includes('\r') || text.includes('\n')) {
        cleanup();
        process.stdout.write('\n');
        resolve(password);
        return;
      }
      if (text.includes('\u001b')) return;
      for (const char of text) {
        if (char === '\u007f' || char === '\b') {
          password = password.slice(0, -1);
          continue;
        }
        if (char < ' ') continue;
        password += char;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function main() {
  const account = envValue('ADMIN_ACCOUNT');
  if (!account) {
    console.error('Admin account is required. Set ADMIN_ACCOUNT in backend/.env.');
    process.exit(1);
  }
  const password = envValue('ADMIN_PASSWORD') || await readPassword(`Admin password (${account}): `);
  if (!password) {
    console.error('Admin password is required. Set ADMIN_PASSWORD in backend/.env.');
    process.exit(1);
  }

  // Passed in memory for this run. Not written to the Postman environment file.
  newman.run({
    collection: collectionPath,
    environment: environmentPath,
    envVar: [
      { key: 'adminEmail', value: account },
      { key: 'adminPassword', value: password },
    ],
    reporters: 'cli',
  }, (err, summary) => {
    const failed = err || (summary && summary.run && (summary.run.error || summary.run.failures.length));
    if (err) console.error(err.message || err);
    process.exit(failed ? 1 : 0);
  });
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
