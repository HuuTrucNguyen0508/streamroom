# Streamroom Glass

Streamroom Glass draws the pointers and pen strokes from a Streamroom call on the real desktop of the person sharing their screen. It puts a see-through layer over the shared monitor. Clicks and typing pass straight through it, so you keep using your computer as usual. Viewers don't need it.

It runs on Linux desktops whose compositor supports wlr-layer-shell. It's tested on Hyprland; Sway and KDE Plasma should work too. GNOME doesn't support it. There's no Windows or macOS version yet.

## Build

You need [Rust](https://rustup.rs) 1.88 or newer. No other libraries are needed to build it. To show names next to pointers, it finds a font with `fc-match` (part of fontconfig, installed on most desktops); without it, the name tags are empty.

```sh
cd glass
cargo build --release
```

The app is `target/release/streamroom-glass`. Copy it anywhere on your `PATH`.

## Run

```sh
streamroom-glass --origin https://streamroom.example.com
```

`--origin` is the address of your Streamroom, exactly as the address bar shows it, without a path. Only Streamroom pages at that address can connect. Give `--origin` more than once to allow several addresses, for example `--origin http://localhost:5173` while developing.

Then share an entire screen in Streamroom and select **Show marks on my desktop** next to the pen on your own share. The command Streamroom shows there already has your address filled in.

At start, the app lists your monitors with their sizes on the desktop. It works out which one you share from the shape of the shared picture. If two monitors have the same shape, the note above the button says so and lists them; start the app again with `--output` and the monitor's name:

```sh
streamroom-glass --origin https://streamroom.example.com --output DP-1
```

Stop it with Ctrl+C. Stopping it, closing the tab or stopping the share clears the layer.

## How it works

Your Streamroom tab already receives every pointer move and pen stroke on your share over the call's `draw` data channel. When the switch is on, the tab also sends the marks on your own share to `ws://127.0.0.1:47291`, one small JSON message each. The app checks the page's address, keeps the marks with the same fade timings as the browser, and paints them on a layer-shell surface on the Overlay layer. That surface has an empty input region and never takes keyboard focus.

- The app listens on 127.0.0.1 only and accepts connections only from the `--origin` addresses, with a `Host` of `127.0.0.1:47291` or `localhost:47291`.
- One tab at a time: a newer tab takes over and the older one stops trying.
- It only draws. It doesn't read the screen, send input or keep anything.

Known limits:

- The layer is part of your screen share, so viewers also see the marks in the video, a moment after their own copy.
- Fractional display scaling isn't handled yet: on a monitor scaled to 125% or 150%, lines are drawn at the next whole scale.
- Rotated monitors are matched by their rotated size. This was tested with a scripted Streamroom tab, not a real browser capture of a rotated monitor.
