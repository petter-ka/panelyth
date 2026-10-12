# Installing, Updating and Removing Panelyth

Panelyth is one program with two apps, the viewer and the commander, in one window. This page is for the person
installing it. How releases are made is in `docs/RELEASING.md`.

## Install

Download the file for your computer from the project's releases page.

| System | File | Install |
|---|---|---|
| Windows 10 or 11, 64-bit | `Panelyth-<version>-win-x64.exe` | Run it. It installs for your account without administrator rights and lets you choose the folder. |
| macOS, Apple silicon | `Panelyth-<version>-mac-arm64.dmg` | Open it and drag Panelyth to Applications. |
| macOS, Intel | `Panelyth-<version>-mac-x64.dmg` | Open it and drag Panelyth to Applications. |
| Linux, 64-bit | `Panelyth-<version>-linux-x86_64.AppImage` | Make it executable (`chmod +x`) and run it. It needs FUSE 2 (`libfuse2`). |
| Linux, 64-bit | `Panelyth-<version>-linux-x64.tar.gz` | Unpack it anywhere and run `panelyth`. |

`SHA256SUMS.txt` on the release lists the checksum of every file.

If the release is not signed:

- **Windows** shows "Windows protected your PC". Choose More info → Run anyway.
- **macOS** refuses to open the app the first time. Right-click Panelyth in Applications and choose Open, or run
  `xattr -dr com.apple.quarantine /Applications/Panelyth.app`.

## Update

Panelyth looks for a newer version when it starts and every six hours. It only looks: nothing is downloaded until
you ask. When a newer version exists, the Settings button in the left rail shows a dot.

Open **Settings → About** (or **Help → Check for Updates…**; on macOS it is in the Panelyth menu):

1. **Check for updates** looks now.
2. A newer version is shown with what changed in it. **Download and install** downloads it.
3. **Restart to update** closes Panelyth, installs the new version and opens it again. If you close Panelyth
   instead, the downloaded version is installed then.

**Check automatically** in the same place turns the automatic check off; the button keeps working.

Some builds cannot install an update themselves and show **Open the download page** instead: a macOS build without
a developer signature, and the Linux `tar.gz`. Install the new version over the old one as you installed the first.

Your settings, bookmarks, ratings and tags are kept across updates.

## Where Panelyth keeps its files

| What | Windows | macOS | Linux |
|---|---|---|---|
| Your data: settings, bookmarks, ratings, tags, saved recipes and connections (`library.db`) | `%APPDATA%\Panelyth` | `~/Library/Application Support/Panelyth` | `~/.config/Panelyth` |
| The cache: thumbnails and the folder index. Safe to delete; it is built again. | `%LOCALAPPDATA%\Panelyth` | `~/Library/Caches/Panelyth` | `~/.cache/Panelyth` |
| Logs | `%APPDATA%\Panelyth\logs` | `~/Library/Logs/Panelyth` | `~/.config/Panelyth/logs` |
| A downloaded update, until it is installed | `%LOCALAPPDATA%\panelyth-updater` | `~/Library/Caches/panelyth-updater` | `~/.cache/panelyth-updater` |

**Help → Open Log Folder** opens the logs. Panelyth never writes into its own program folder, and never beside your
pictures: a thumbnail of a file on drive `D:` is in the cache folder above.

Passwords of saved FTP connections are encrypted with the system's secret store (Windows DPAPI, the macOS Keychain,
libsecret on Linux) and are in `library.db` only in that form.

## Remove

- **Windows**: Settings → Apps → Installed apps → Panelyth → Uninstall.
- **macOS**: move Panelyth from Applications to the Trash.
- **Linux**: delete the AppImage or the unpacked folder.

Removing the program keeps your data and the cache. To remove them too, delete the folders in the table above.

## Known limits

- **Videos on macOS** need `ffmpeg` and `ffprobe` installed (for example with Homebrew) for posters, durations and
  sizes. Windows and Linux packages bring their own.
- **7z and RAR archives** in the commander need 7-Zip installed. Zip and tar archives need nothing.
- **An older version after a newer one**: if a newer version changed the data file, an older version runs without
  your settings and bookmarks, and leaves them untouched for the newer one. Install the newer version again to get
  them back.
- **The first visit to a folder after some updates** lists it again, when the update changed the index.
- **Unsigned macOS builds** cannot update themselves (see Update).
- **Third-party licences**: Help → Third-Party Licenses opens the notices of everything Panelyth includes.
