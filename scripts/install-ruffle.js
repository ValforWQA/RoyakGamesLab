'use strict';
// Copies the complete self-hosted Ruffle bundle from npm's installed package.
const fs = require('fs'); const path = require('path');
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'vendor/royakruffle');
const pkg = path.join(root, 'node_modules/@ruffle-rs/ruffle');
if (!fs.existsSync(pkg)) { console.error('Install dependencies first: npm install'); process.exit(1); }
const candidates = [pkg, path.join(pkg, 'dist')];
const source = candidates.find(p => fs.existsSync(path.join(p, 'ruffle.js')));
if (!source) { console.error('Cannot locate ruffle.js in @ruffle-rs/ruffle; inspect the installed package layout.'); process.exit(1); }
fs.mkdirSync(target, {recursive:true});
for (const name of fs.readdirSync(source)) {
 const src = path.join(source,name); const dst = path.join(target,name);
 if (fs.statSync(src).isFile() && /\.(js|wasm|map)$/.test(name)) fs.copyFileSync(src,dst);
}
if (!fs.existsSync(path.join(target, 'ruffle.js')) || !fs.readdirSync(target).some(n => n.endsWith('.wasm'))) {
 console.error('Incomplete Ruffle runtime; WASM missing.'); process.exit(1);
}
console.log('RoyakRuffle offline runtime installed:', target);
