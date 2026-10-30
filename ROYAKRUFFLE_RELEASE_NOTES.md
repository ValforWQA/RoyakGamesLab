# RoyakGamesLab 1.1.1 — RoyakRuffle/1.0.0

- Custom Electron game-window User-Agent: `RoyakGamesLabAgent RoyakRuffle/1.0.0`.
- Offline Ruffle dependency pinned to `0.8.0-nightly.2026.10.29` (published nightly).
- Local JS/WASM installation: `npm install && npm run setup:ruffle`.
- Game windows use locally installed `vendor/royakruffle/ruffle.js` and WASM.
- External web links continue opening the OS default browser.
- Renderer preference uses `wgpu-webgl` for broad WebGL compatibility; hardware acceleration is dependent on GPU/drivers.
- Windows installer: `npm run dist`.

NOTE: Compiled WASM is not included because npm registry access was unavailable in the build environment. This ZIP is source, not a Windows EXE. `npm install` generates a new lockfile. Runtime/gameplay testing on Windows is still required.

Server-side GameFileController must recognize `RoyakRuffle/1.0.0` and `RoyakGamesLabAgent` before generic Ruffle rejection. The identity is not authentication.
