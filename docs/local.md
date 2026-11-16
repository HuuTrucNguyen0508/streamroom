# Run Streamroom on your own computer

This guide runs Streamroom straight on your computer with Bun. You don't need Docker, a domain, or a Cloudflare account. It suits trying the app out, development, and calls with friends on your Tailscale network. To host it for friends anywhere on the internet, use [Cloudflare](cloudflare.md) or the [HTTPS setup](../README.md#invite-friends-over-https) instead.

## What you need

- [Bun](https://bun.sh) 1.4.4 or newer
- [Node.js](https://nodejs.org) 24 or newer
- [pnpm](https://pnpm.io) 12 (`corepack enable` sets it up from `package.json`)
- A desktop Chromium browser, such as Chrome, Edge or Brave, to share your screen

## Start it

```sh
git clone https://github.com/HuuTrucNguyen0508/streamroom.git
cd streamroom
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

The server prints `streamroom listening on http://0.0.0.0:8080`. Open <http://localhost:8080>, choose how many seats the room has, and copy the invite link. Stop the server with Ctrl+C.

To try a call by yourself, open the invite link in a second browser window. Mute one window or wear headphones, or the two windows will echo.

If port 8080 is busy, start on another port:

```sh
PORT=8090 pnpm start
```

## Host passphrase

Without `HOST_PASSPHRASE`, anyone who can reach the server can create rooms, and the server prints a warning. That is fine while only you can reach it. Set a passphrase before other people can reach it:

```sh
HOST_PASSPHRASE='a long private phrase' pnpm start
```

The start page then asks for the passphrase. Friends who open an invite link don't need it.

Bun also reads a `.env` file in the project folder, so you can put `HOST_PASSPHRASE`, `PORT` and other settings there. Copy [`.env.example`](../.env.example) to start one.

## Call friends

Browsers only allow the microphone and screen capture on `localhost` or on HTTPS pages. A friend who opens `http://192.168.1.20:8080` on your Wi-Fi can load the page, but their browser blocks the microphone and screen sharing. Give them an HTTPS address instead.

The simplest way is [Tailscale](https://tailscale.com). Everyone joins the same tailnet, and Tailscale Serve gives your computer an HTTPS address:

```sh
HOST_PASSPHRASE='a long private phrase' pnpm start
tailscale serve --bg 8080
```

`tailscale serve status` shows the address, such as `https://your-pc.your-tailnet.ts.net`. Open it, create a room, and send the invite link to your friends. Calls connect directly between the computers on the tailnet. Turn Serve off with `tailscale serve reset`.

## Limits of the local setup

- Without a TURN server, calls only connect when the browsers can reach each other directly: on the same machine, the same network, or the same tailnet. For friends on other networks, run the [Docker setup](../README.md#docker), which includes coturn.
- Invite links, rooms and chat live in memory, so they disappear when you stop the server.
- After you pull new code, run `pnpm build` again before `pnpm start`, because the server serves the built files in `dist/web`.

To change the code with live reload, see [Develop and test](../README.md#develop-and-test).
