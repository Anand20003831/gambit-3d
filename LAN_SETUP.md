# Playing over your own Wi-Fi (Windows)

Two devices in the same house, no internet connection needed. One computer runs
the game; everything else joins with a browser.

---

## The short version

On the computer that will host:

```bash
npm run start:lan
```

It prints something like:

```
  Computer:  my-pc
  Port:      8787

  Share this address with other devices on your Wi-Fi:

      http://192.168.55.235:8787

  (found on the "Ethernet" adapter)
```

Type that address into the browser on the other device. That is the whole thing.

> **The address will not be `localhost` or `127.0.0.1`.** Those mean "this
> computer" and will never work from a phone. The tool deliberately refuses to
> print them as the shareable address, and marks them "not usable" if it lists
> them at all.

---

## Step by step

### 1. Put both devices on the same network

Same Wi-Fi name, or one on Wi-Fi and one on the router by cable — both are fine,
as long as it is the same router.

Guest networks usually **block** devices from seeing each other. If your router
has "AP isolation", "client isolation" or "guest mode" switched on for that
network, use the main network instead.

### 2. Start the server

```bash
npm run start:lan
```

The first run builds the app, which takes a minute. Later runs start instantly.

This is the same as `npm start` except it binds to `0.0.0.0` instead of
`127.0.0.1`. Binding to `0.0.0.0` is what makes the server answer requests from
other devices.

### 3. Allow it through the Windows firewall

The **first** time you run it, Windows shows:

> *Windows Defender Firewall has blocked some features of this app*
> Allow **Node.js JavaScript Runtime** to communicate on these networks:
> ☐ Private networks, such as my home or work network
> ☐ Public networks, such as those in airports and coffee shops

Tick **Private networks** and click **Allow access**.

Leave **Public networks** unticked. Only tick it if you know your home network is
classified as Public in Windows and you accept what that means.

#### If you missed the prompt, or clicked Cancel

Open **PowerShell as Administrator** and run:

```powershell
New-NetFirewallRule -DisplayName "Gambit3D chess (LAN)" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Private
```

To check the rule exists:

```powershell
Get-NetFirewallRule -DisplayName "Gambit3D chess (LAN)" | Format-List DisplayName, Enabled, Direction, Action, Profile
```

To remove it again later:

```powershell
Remove-NetFirewallRule -DisplayName "Gambit3D chess (LAN)"
```

#### Check what Windows thinks your network is

```powershell
Get-NetConnectionProfile | Select-Object Name, InterfaceAlias, NetworkCategory
```

If `NetworkCategory` says `Public` for your home Wi-Fi, either change it to
private (Settings → Network & Internet → Wi-Fi → your network → Private network)
or add the firewall rule with `-Profile Public` instead.

### 4. Open the game on the other device

Type the address into any browser. On a phone, the game's **Local Wi-Fi** page
also shows a QR code you can point a camera at.

### 5. Start a game

On the host: **Local Wi-Fi** → pick a time control and a map → **Create Wi-Fi
room**. The room's **Room** panel shows the exact join link and a QR code for
that specific room.

On the other device: it will already be on the menu — use **Have a code?** and
type the room code, or scan the QR code, or just open the link.

---

## Finding the address without starting the server

```bash
npm run lan:info
```

Prints the best address, any alternatives, and lists loopback addresses
explicitly as *not usable from other devices* so there is no ambiguity.

Add `--json` for machine-readable output:

```bash
node scripts/lan-info.mjs --json
```

## Using a different port

```bash
node scripts/start-lan.mjs --port 9000
```

Remember to open that port in the firewall instead of 8787.

---

## When it does not work

Work through these in order.

### "This site can't be reached" on the other device

1. **Check the address.** It must be the one the tool printed, including
   `http://` and the `:8787` port. Not `https://`.
2. **Check the server is actually listening on all interfaces.** The startup
   banner must say `bind=0.0.0.0:8787`. If it says `127.0.0.1`, you started it
   with `npm start` instead of `npm run start:lan`.
3. **Firewall.** By far the most common cause. Re-read step 3.
4. **Test from the host itself first.** Open the LAN address (not localhost) in a
   browser *on the host computer*. If that fails, the problem is the server or
   the firewall, not the network.

### The tool prints several addresses

Windows machines often have extra virtual adapters — VirtualBox, VMware, Hyper-V,
WSL, Docker, Tailscale. The tool ranks real Wi-Fi and Ethernet adapters first and
pushes virtual ones down, but if the top choice does not work, try the others
from the **Local Wi-Fi** page in the game or from `npm run lan:info`.

A `169.254.x.x` address means Windows could not get an address from your router.
Reconnect to the network before sharing anything.

### It says "No private network address found"

The computer is not connected to any network. Connect to Wi-Fi or plug in a cable.

### The phone connects but the game never loads

Almost always a browser cache from an earlier attempt. Pull to refresh, or open
the address in a private tab.

### Moves are slow or the connection keeps dropping

Check the signal on the phone. The connection banner at the top of the game says
when it is reconnecting; your game and clock are held on the server, so you will
not lose the position.

---

## Notes

- **No internet is needed.** Nothing is fetched from outside your network once
  the app is built.
- **Anyone on your network can join.** There is no authentication beyond the room
  code. If that matters, set a room password when you create the room.
- **The server stores its database** at `packages/server/data/gambit3d.db`.
  Delete that file to reset ratings and finished-game history.
- **Stopping the server:** press `Ctrl+C` in the terminal.
