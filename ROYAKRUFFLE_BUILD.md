# RoyakRuffle — Electron self-hosted WebAssembly integration

This is a source integration build, **not a compiled modified Rust fork**. The Ruffle JS/WASM distribution must be installed on a network-connected build machine before the launcher can play SWFs.

## Windows setup

1. Install Node.js and npm.
2. Run `npm install`.
3. Run `npm run setup:ruffle` to copy the JS/WASM bundle to `vendor/royakruffle`.
4. Run `npm start` to test, then `npm run dist` to package.

The Ruffle package version in package.json is a provisional nightly spec; if npm cannot resolve it, install a currently published `@ruffle-rs/ruffle` version and rerun setup. Commit/pin the exact resolved version before release.

## What changed

- No Ruffle CDN: game HTML references local `vendor/royakruffle/ruffle.js` and sets the WASM publicPath.
- Launcher still uses its existing external browser behavior and GPU flags.
- New optional per-server `play.diagnostics: true` overlays render-callback rate and JavaScript heap usage. This is NOT SWF simulation FPS.
- External game SWF URLs and FlashVars are retained.
- Ruffle's AVM2 / ActionScript 3 and SmartFoxServer socket behavior are **not verified**. WebSocket transport and Flash XMLSocket are not interchangeable.
- GPU backend selection is a request, not proof of actual GPU usage. Benchmark with Chromium GPU diagnostics.

## Next stage — actual fork

Fork github.com/ruffle-rs/ruffle, build its web target, replace the files under `vendor/royakruffle`, and profile AVM2, display-list rendering, decoding, networking and GC. Preserve upstream licensing and notices. Do not modify timing or drop frames without validating gameplay.
