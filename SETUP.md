# Setting up your computer

Every project here works on **macOS, Windows and Linux**. You need:

| Tool | Why | Check it with |
|---|---|---|
| [PlatformIO Core](https://platformio.org/install/cli) | builds and uploads firmware to the ESP32-C3 | `pio --version` |
| [Node.js](https://nodejs.org/) 18 or newer | runs the local web pages (Game Boy streamer, 3D editor, video streamer) | `node --version` |
| [Git](https://git-scm.com/) | downloads the projects | `git --version` |
| [ffmpeg](https://ffmpeg.org/) (optional) | video conversion in the video streamer | `ffmpeg -version` |
| **Chrome** or **Edge** | the web pages talk to the board over USB with Web Serial (Safari and Firefox don't have it) | |

You also need a **USB-C data cable**. Many cables are charge-only, so if the board never shows up, try another cable first.

## Installation

### macOS

1. Install [Homebrew](https://brew.sh) if you don't have it, by pasting this into Terminal:
   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```
2. Install the tools:
   ```bash
   brew install node platformio git ffmpeg
   ```
3. No USB driver is needed: the ESP32-C3's built-in USB shows up as `/dev/cu.usbmodem…`.

### Windows 10 / 11

1. Open **PowerShell** and install the tools with winget:
   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install Git.Git
   winget install Gyan.FFmpeg
   winget install Python.Python.3.12
   ```
2. **Close and reopen PowerShell** so the new tools are on your PATH, then install PlatformIO:
   ```powershell
   py -m pip install --user platformio
   ```
3. Check it with `pio --version`.
   - If `pio` isn't found, add the folder that pip printed a "not on PATH" warning about to your PATH, usually `%APPDATA%\Python\Python312\Scripts`. Do this in Settings → System → About → Advanced system settings → Environment Variables.
   - Then reopen PowerShell.
4. No USB driver is needed: Windows 10 and 11 include one for the ESP32-C3. The board appears as a **COM** port.

### Linux (Ubuntu / Debian)

1. Install the tools:
   ```bash
   sudo apt update
   sudo apt install git ffmpeg pipx curl
   pipx install platformio && pipx ensurepath
   ```
2. Install Node.js 18 or newer. Older Ubuntu releases ship an old version, so check `node --version`; if it's below 18, install the current LTS:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
   sudo apt install nodejs
   ```
3. Allow your user to access the USB serial port, then **log out and back in**:
   ```bash
   sudo usermod -aG dialout $USER
   curl -fsSL https://raw.githubusercontent.com/platformio/platformio-core/develop/platformio/assets/system/99-platformio-udev.rules | sudo tee /etc/udev/rules.d/99-platformio-udev.rules
   sudo udevadm control --reload-rules && sudo udevadm trigger
   ```
4. Use Chrome, Chromium or Edge. The board appears as `/dev/ttyACM0`.

## Uploading a firmware project

Every firmware folder (`esp32-eyes`, `matrix-rain`, `night-city`…) is a PlatformIO project. With the board plugged in:

```bash
cd esp32-eyes
pio run -t upload
```

PlatformIO finds the board automatically. The first build downloads the ESP32 toolchain, which takes a few minutes; later builds take seconds. If the upload can't connect, hold **BOOT**, unplug and re-plug the board, release BOOT, and try again.

The board appears as `/dev/cu.usbmodem…` on macOS, `COM…` on Windows, and `/dev/ttyACM…` on Linux. Run `pio device list` to see it.
