# Run Access Web on your own PC

Access Web runs fine as a standalone app on one computer: a small local web server that you open in your
browser at **http://localhost:3000**. It needs no internet connection, and your databases are stored in a
`data` folder next to the app. By default only that computer can open it.

There are two ways to install it:

| | **A. Installer** (recommended) | **B. Docker Desktop** |
| --- | --- | --- |
| You install | Nothing first; one command does it all | Docker Desktop, Git |
| Start it | *Access Web* shortcut | `docker compose up -d` |
| Data lives in | `AccessWeb\data` in your user folder | a Docker volume |
| Good for | Everyday use on a PC or Mac | If you already use Docker |

---

## A. Installer (Windows, macOS, Linux)

The installer needs no admin rights and asks no questions. It downloads private copies of Node.js, Java
and Maven into the app folder (nothing is installed system-wide and your *Path* isn't changed), builds the
app, adds a shortcut, and starts it. It takes a few minutes and needs an internet connection.

### Windows 10 / 11

Either double-click **`install.cmd`**, or open **PowerShell** and paste:

```powershell
irm https://raw.githubusercontent.com/atmanning/AccessWebApp/main/install.ps1 | iex
```

### macOS / Linux

Open **Terminal** and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/atmanning/AccessWebApp/main/install.sh | bash
```

### Using it

- The app is installed in **`AccessWeb`** in your user folder, and your browser opens
  **http://localhost:3000** when it's done. Register an account the first time; on your own PC it's just
  your local login.
- **Start it** from the *Access Web* shortcut (Windows: Desktop and Start menu; macOS: Desktop; Linux:
  applications menu). A window shows the server; close it (or press **Ctrl+C**) to stop.
- **Update** by running the same install command again. Your data is kept, and if the new version fails to
  build the previous one is put back.
- **Back up** by stopping the app and copying the **`data`** folder somewhere safe (it holds
  `access-web.db` with every account and database, and `connection.key`, which unlocks saved MySQL
  passwords). To restore, put the folder back. You can also download any single database as an Access
  `.accdb` file (*File > Export*).
- **Uninstall** by deleting the `AccessWeb` folder and the shortcut.

**Installer options** (Windows: set as environment variables before `irm | iex`, or pass to
`install.ps1`; macOS/Linux: environment variables, or flags after `| bash -s --`):

| Option | Windows | macOS / Linux |
| --- | --- | --- |
| Install somewhere else | `$env:ACCESSWEB_DIR="D:\AccessWeb"` | `--dir ~/Apps/AccessWeb` |
| Don't start it afterwards | `$env:ACCESSWEB_NO_START=1` | `--no-start` |
| Install from a downloaded copy (offline, USB) | `-Source AccessWebApp-main.zip` | `--source AccessWebApp-main.tar.gz` |

**Handy extras (Windows)**

- **Start automatically when you sign in:** press **Win+R**, type `shell:startup`, Enter, and copy the
  *Access Web* shortcut into the folder that opens. Right-click it > *Properties* > *Run:* **Minimized**.
- **Different port** (if 3000 is taken): edit `start-local.cmd` and change `set PORT=3000`. On macOS/Linux,
  edit `PORT` in `start-local.sh`.
- **Use it from other computers on your network:** change `set HOST=127.0.0.1` to `set HOST=0.0.0.0`, allow
  Node.js through Windows Firewall when asked, and open `http://<this-PC's-name-or-IP>:3000` on the other
  computer. Anyone on your network can then reach the sign-in page, so only do this on a network you trust.

### For developers: build from a Git checkout

If you already have Node.js 22+, Java 21 JDK and Maven 3.6.3+ on your *Path*:

```bash
git clone https://github.com/atmanning/AccessWebApp.git
cd AccessWebApp
npm ci && npm run build && npm run build:exporter
./start-local.sh        # Windows: start-local.cmd
```

On a fresh Windows PC, first run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force` in PowerShell, or
`npm` fails with *"running scripts is disabled on this system"* (the installer isn't affected). Update with
`git pull` and the same build commands. (The installer refuses to install into a Git checkout,
so it never overwrites your working copy.)

---

## B. Docker Desktop (Windows, macOS or Linux)

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and Git, and start Docker Desktop.
2. In a terminal:

   ```bash
   git clone https://github.com/atmanning/AccessWebApp.git
   cd AccessWebApp
   docker compose up -d --build
   ```

3. Open **http://localhost:3000**.

Docker builds everything it needs (including Java), so nothing else is installed. Stop it with
`docker compose stop`, start it again with `docker compose start` (it also restarts with Docker Desktop).
Update with `git pull` then `docker compose up -d --build`. Data stays in the `access-web-data` volume.

Notes for Docker:

- To reach a MySQL server **on the same PC** from the app, use the host name `host.docker.internal` and add
  `ALLOW_PRIVATE_DB_HOSTS: "true"` under `environment:` in `docker-compose.yml`.
- To keep it to this PC only, change the port line to `"127.0.0.1:3000:3000"`.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `npm ci` fails building **better-sqlite3** (`node-gyp rebuild`, `gyp ERR! find VS`) | The project folder is missing its `.npmrc` file (it holds `ignore-scripts=true`; without it npm 11 tries to compile SQLite instead of using the ready-made build). Get the latest version of the app, or create the file in the project folder with PowerShell: `Set-Content .npmrc "ignore-scripts=true"`. Then delete `node_modules` and run `npm ci` again. Any Node.js 22 or newer works. |
| Installer says it couldn't reach nodejs.org / api.adoptium.net / github.com | A firewall or proxy is blocking it. Try another network, or download the app zip on another computer and use the *install from a downloaded copy* option. |
| Installer says the exporter didn't build | Maven couldn't download its libraries (usually a network hiccup). Everything except `.accdb` import/export works; run the installer again to retry. |
| `mvn` / `java` not recognized (developer build) | Open a **new** PowerShell window after installing; check the Maven `bin` folder is on *Path*. |
| `No compiler is provided in this environment. Perhaps you are running on a JRE rather than a JDK?` | Maven found a Java *runtime* instead of the JDK (usually an older Java with `JAVA_HOME` pointing at it). Install the JDK (`winget install --id EclipseAdoptium.Temurin.21.JDK -e`), set `JAVA_HOME` to its folder (e.g. `C:\Program Files\Eclipse Adoptium\jdk-21…`) and put its `bin` first on *Path*, then open a new PowerShell. `mvn -v` should show that folder as **Java home**. A system-wide `JAVA_HOME` overrides yours: change it under *Edit the system environment variables*. |
| `npm : File C:\Program Files\nodejs\npm.ps1 cannot be loaded because running scripts is disabled on this system` (developer build) | Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force` in PowerShell (or type `npm.cmd` instead of `npm`). The installer doesn't need this. |
| "Port 3000 is already in use" / `EADDRINUSE` | Another program uses it: change `PORT` in `start-local.cmd`. |
| Can't sign in (page reloads to the sign-in screen) | Make sure you started it with `start-local.cmd`/`start-local.sh`, which turn off https-only cookies for `http://localhost`. |
| Access import/export says Java or the exporter is missing | Run the installer again (developer build: install Java 21+, then `npm run build:exporter`). |
