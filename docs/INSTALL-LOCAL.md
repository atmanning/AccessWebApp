# Run Access Web on your own PC

Access Web runs fine as a standalone app on one computer: a small local web server that you open in your
browser at **http://localhost:3000**. It needs no internet connection, and your databases are stored in a
`data` folder next to the app. By default only that computer can open it.

There are two ways to install it:

| | **A. Direct install** (recommended) | **B. Docker Desktop** |
| --- | --- | --- |
| You install | Node.js, Java, Maven, Git | Docker Desktop, Git |
| Start it | Double-click `start-local.cmd` | `docker compose up -d` |
| Data lives in | `data\` in the app folder | a Docker volume |
| Good for | Everyday use on a PC | If you already use Docker |

---

## A. Direct install on Windows 10 / 11

### 1. Install the tools (once)

Open **PowerShell** and run (each `winget` line installs one tool; accept the prompts):

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id EclipseAdoptium.Temurin.21.JDK -e
winget install --id Git.Git -e
```

Then install **Maven** (it builds the part that reads and writes `.accdb` files):

1. Download the **Binary zip archive** (`apache-maven-3.9.x-bin.zip`) from <https://maven.apache.org/download.cgi>.
2. Extract it to `C:\Tools` so you have `C:\Tools\apache-maven-3.9.x\bin`.
3. Start menu → *Edit the system environment variables* → **Environment Variables…** → under *User variables*
   select **Path** → **Edit** → **New** → paste `C:\Tools\apache-maven-3.9.x\bin` (your actual folder name) → OK.

**Close PowerShell and open a new one**, then check everything is found:

```powershell
node --version    # v22 or newer
java --version    # 21 or newer
mvn --version     # 3.6.3 or newer
git --version
```

> Java and Maven are only needed for importing and exporting Access `.accdb` files. Without them everything
> else works, and the app tells you when you try an Access import or export.

### 2. Download and build the app (once, takes a few minutes)

```powershell
cd $HOME
git clone https://github.com/atmanning/AccessWebApp.git
cd AccessWebApp
npm ci
npm run build
npm run build:exporter
```

Git may open a browser window to sign in to GitHub if the repository is private.

### 3. Start it

Double-click **`start-local.cmd`** in the `AccessWebApp` folder (in File Explorer: your user folder →
`AccessWebApp`). A window opens showing the server, and your browser opens **http://localhost:3000** after a
few seconds. Register an account the first time — on your own PC it's just your local login.

To stop it, close that window (or press **Ctrl+C** in it).

**Handy extras**

- **Desktop shortcut:** right-click `start-local.cmd` → *Show more options* → *Send to* → *Desktop (create shortcut)*.
- **Start automatically when you sign in:** press **Win+R**, type `shell:startup`, Enter, and put a shortcut to
  `start-local.cmd` in the folder that opens. Right-click the shortcut → *Properties* → *Run:* **Minimized**.
- **Different port** (if 3000 is taken): edit `start-local.cmd` and change `set PORT=3000`.
- **Use it from other computers on your network:** change `set HOST=127.0.0.1` to `set HOST=0.0.0.0`, allow
  Node.js through Windows Firewall when asked, and open `http://<this-PC's-name-or-IP>:3000` on the other
  computer. Anyone on your network can then reach the sign-in page, so only do this on a network you trust.

### 4. Update to a newer version

Stop the app, then in PowerShell:

```powershell
cd $HOME\AccessWebApp
git pull
npm ci
npm run build
npm run build:exporter
```

Your databases in `data\` are kept; the app upgrades its storage automatically on the next start.

### 5. Back up your data

Stop the app and copy the **`data`** folder somewhere safe (it holds `access-web.db` with every account and
database, and `connection.key`, which unlocks saved MySQL passwords). To restore, put the folder back.

You can also download any single database as an Access `.accdb` file (*File → Export*) as an extra copy.

---

## A. Direct install on macOS or a Linux desktop

Install the same tools — macOS with [Homebrew](https://brew.sh):

```bash
brew install node@22 openjdk@21 maven git
```

(Ubuntu/Debian: see step 1 of [INSTALL-LINUX.md](INSTALL-LINUX.md).) Then:

```bash
git clone https://github.com/atmanning/AccessWebApp.git
cd AccessWebApp
npm ci && npm run build && npm run build:exporter
./start-local.sh
```

Your browser opens http://localhost:3000. Stop it with **Ctrl+C**. Data is in `AccessWebApp/data`. Update with
`git pull && npm ci && npm run build && npm run build:exporter`.

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
| `npm ci` fails building **better-sqlite3** | Use a current Node.js **LTS** release (22 or 24) — it downloads a ready-made build. Very new non-LTS Node versions may need Visual Studio Build Tools. |
| `mvn` / `java` not recognized | Open a **new** PowerShell window after installing; check the Maven `bin` folder is on *Path*. |
| "Port 3000 is already in use" / `EADDRINUSE` | Another program uses it: change `PORT` in `start-local.cmd`. |
| Can't sign in (page reloads to the sign-in screen) | Make sure you started it with `start-local.cmd`/`start-local.sh`, which turn off https-only cookies for `http://localhost`. |
| Access import/export says Java or the exporter is missing | Install Java 21+, then run `npm run build:exporter`. |
