RoyakFlashEngine local socket bridge

Ruffle WebSocket -> loopback relay -> TCP SmartFoxServer.
Configured destination: 20.118.25.131:5583 in launcher-config.json game.ruffle.socketTargets.
For other game server endpoints, add exact host/port pairs to socketTargets.
No remote inbound listener, no generic open proxy, no additional npm dependencies.
This is a diagnostic build: end-to-end SmartFoxServer login must be tested on Windows.
The SWF and PHP GameFileController are unchanged by this socket patch.
