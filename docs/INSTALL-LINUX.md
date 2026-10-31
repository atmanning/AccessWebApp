# Install Access Web on a Linux server

One Node.js process serves both the web app and its API, and stores everything in a single SQLite file. No
separate database server is needed. This guide installs it as a `systemd` service that starts at boot and
restarts if it stops, then puts it on your network one of two ways:

- **With a domain name and HTTPS** (recommended, required if it's reachable from the internet): nginx in front,
  with a free Let's Encrypt certificate.
- **On a private network without a domain:** served directly over http on port 3000.

Written for **Ubuntu 24.04 LTS** and **Debian 13**; other distributions need the same packages (notes at the
end). Any machine with 1 GB of RAM or more works; 2 GB is comfortable for large Access imports and exports.

Prefer containers? See [Docker on Linux](#docker-on-linux-alternative) at the end.

---

## 1. Install the packages

```bash
sudo apt update
sudo apt install -y git curl ca-certificates openssl sqlite3 openjdk-21-jdk-headless maven

# Node.js 22 LTS from NodeSource (the distribution's own Node.js is too old)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

node --version   # v22.x
java --version   # 21.x
mvn --version    # 3.6.3 or newer
```

Java is used only for importing and exporting Access `.accdb` files; Maven only to build that part.

## 2. Create the service account

The app runs as its own unprivileged user that can write only to `/var/lib/access-web`:

```bash
sudo useradd --system --home-dir /var/lib/access-web --shell /usr/sbin/nologin accessweb
```

## 3. Download and build the app

Build as your normal user (not root), into `/opt/access-web`:

```bash
sudo mkdir -p /opt/access-web
sudo chown "$USER": /opt/access-web
git clone https://github.com/atmanning/AccessWebApp.git /opt/access-web
cd /opt/access-web
npm ci
npm run build
npm run build:exporter
```

If the repository is private, use a GitHub personal access token as the password, or a deploy key.

## 4. Configure

```bash
cd /opt/access-web
sudo install -m 600 -o root -g root deploy/linux/access-web.env.example /etc/access-web.env
# Generate the key that encrypts saved MySQL passwords:
sudo sed -i "s/^CONNECTION_SECRET=.*/CONNECTION_SECRET=$(openssl rand -hex 32)/" /etc/access-web.env
sudo nano /etc/access-web.env
```

The defaults suit the HTTPS setup (5A). For a private network without a domain (5B), change:

```ini
HOST=0.0.0.0
SECURE_COOKIES=false
TRUST_PROXY=false
```

Set `ALLOW_PRIVATE_DB_HOSTS=true` if users should connect to MySQL servers on this machine or your internal
network. Leave it `false` on an internet-facing server so the app can't be used to probe your network.
All settings are listed in the [README](../README.md#configuration).

## 5. Start the service

```bash
sudo cp /opt/access-web/deploy/linux/access-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now access-web

systemctl status access-web                 # should say "active (running)"
curl http://127.0.0.1:3000/api/health       # {"ok":true}
journalctl -u access-web -f                 # live log (Ctrl+C to leave)
```

If `node` isn't at `/usr/bin/node` (for example you used nvm), fix the `ExecStart=` path in the unit file
(`which node` shows it) and run `sudo systemctl daemon-reload && sudo systemctl restart access-web`.

### 5A. With a domain and HTTPS (nginx + Let's Encrypt)

Point a DNS name (e.g. `access.example.com`) at the server, then:

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp /opt/access-web/deploy/linux/nginx-access-web.conf /etc/nginx/sites-available/access-web
sudo sed -i 's/access.example.com/YOUR.DOMAIN/' /etc/nginx/sites-available/access-web
sudo ln -s /etc/nginx/sites-available/access-web /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d YOUR.DOMAIN          # gets the certificate and turns on HTTPS + redirect
```

If you use a firewall: `sudo ufw allow 'Nginx Full'`. Port 3000 stays closed to the outside, because the app
listens only on `127.0.0.1`. Open **https://YOUR.DOMAIN** and register the first account.

### 5B. On a private network without a domain

With `HOST=0.0.0.0` and `SECURE_COOKIES=false` set in step 4 (`sudo systemctl restart access-web` after
editing), open the port if you use a firewall, limited to your network:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 3000 proto tcp   # use your network's range
```

Browse to **http://SERVER-IP:3000**. Traffic, including passwords, isn't encrypted on plain http, so use this
only on a network you trust. Use 5A for anything reachable from the internet.

## 6. Updating

```bash
cd /opt/access-web
git pull
npm ci
npm run build
npm run build:exporter
sudo systemctl restart access-web
```

Data in `/var/lib/access-web` is kept; the app upgrades its storage automatically on start. Check
`deploy/linux/` for changed files after an update (the README notes when a new setting is added).

## 7. Backups

Everything is in `/var/lib/access-web/access-web.db`. The included script makes a consistent copy while the app
runs and keeps 14 days:

```bash
sudo /opt/access-web/deploy/linux/backup-access-web.sh /var/backups/access-web
# daily at 02:00:
echo '0 2 * * * root /opt/access-web/deploy/linux/backup-access-web.sh /var/backups/access-web' | sudo tee /etc/cron.d/access-web-backup
```

Also keep a copy of `/etc/access-web.env`: its `CONNECTION_SECRET` is needed to use saved MySQL passwords.
Copy the backups off the server (another machine or cloud storage).

**Restore:**

```bash
sudo systemctl stop access-web
gunzip -c /var/backups/access-web/access-web-YYYYMMDD-HHMMSS.db.gz | sudo tee /var/lib/access-web/access-web.db >/dev/null
sudo rm -f /var/lib/access-web/access-web.db-wal /var/lib/access-web/access-web.db-shm
sudo chown accessweb:accessweb /var/lib/access-web/access-web.db
sudo systemctl start access-web
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Service won't start | `journalctl -u access-web -n 50`: usually a wrong path in `ExecStart=`, the app not built (`server/dist` or `web/dist` missing), or port 3000 in use (change `PORT`). |
| Sign-in doesn't stick (back to the sign-in page) | `SECURE_COOKIES=true` while browsing over plain http. Use HTTPS (5A) or set it `false` (5B). |
| "Too many attempts" for everyone behind nginx | `TRUST_PROXY=true` is needed behind nginx so each visitor's own address is used. |
| Access import/export error mentioning Java | `java --version` works, and `/opt/access-web/exporter/target/access-exporter.jar` exists (`npm run build:exporter`). |
| Large Access upload fails with 413 | `client_max_body_size` in the nginx site (110m in the provided file). |
| MySQL connection refused for a local/internal server | `ALLOW_PRIVATE_DB_HOSTS=true` in `/etc/access-web.env`, then restart. |

**Other distributions:** Fedora / RHEL / Rocky / Alma: `sudo dnf install git java-21-openjdk-devel maven sqlite`,
and Node.js 22 from <https://rpm.nodesource.com> (or `dnf module install nodejs:22` where offered). Debian 12
has no Java 21 package: install Temurin 21 from <https://adoptium.net/installation/linux/>. The rest of the
guide is the same.

---

## Docker on Linux (alternative)

If Docker is installed, the repository's `Dockerfile` builds everything, including Java, and the container runs
as an unprivileged user:

```bash
git clone https://github.com/atmanning/AccessWebApp.git /opt/access-web
cd /opt/access-web
docker compose up -d --build
```

It serves http on port 3000 with its data in the `access-web-data` volume, and restarts with Docker. For HTTPS,
put nginx (5A) in front, change the port line in `docker-compose.yml` to `"127.0.0.1:3000:3000"`, and set
`SECURE_COOKIES: "true"` and `TRUST_PROXY: "true"`. Add `CONNECTION_SECRET` there too, or keep the
`connection.key` file the app creates in the volume. Update with `git pull && docker compose up -d --build`.
Back up with
`docker compose exec access-web node -e "require('better-sqlite3')('/data/access-web.db').backup('/data/backup.db')"`,
then copy `backup.db` out with `docker compose cp access-web:/data/backup.db .`.
