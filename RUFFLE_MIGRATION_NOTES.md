# Ruffle migration (experimental)

- External navigation opens the operating-system default browser.
- SWF games launch in independent Electron windows using Ruffle.
- GPU rasterization is requested; GPU availability and FPS depend on drivers, OS and Ruffle.
- The Ruffle script currently loads from a CDN. For offline production builds, bundle an official matching Ruffle web distribution locally and update the script path.
- IMPORTANT: Ruffle does not guarantee compatibility with Adventure Vanilla AS3, networking, or legacy Flash behavior. Validate login, socket policy, gameplay and audio.
- This is source code, not a tested Windows installer. Run npm install and npm start.
