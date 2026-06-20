# Shoom deployment

Everything runs in Docker on the VPS. **Deploy is git-only**: commit → push → on the
server `git pull` → `docker compose up`. Never copy files onto the server by hand.

## Server layout

```
/opt/shoom/
├── shoom/           # frontend repo (Next.js)
└── shoom-backend/   # backend repo — compose + configs live here, run all commands from here
```

## First-time bootstrap

```bash
# 1. Install Docker (get.docker.com), open firewall:
#    ufw allow 22,80,443/tcp; ufw allow 7881/tcp; ufw allow 50000:60000/udp; ufw allow 3478/udp
#    # let containers reach the host-networked LiveKit signaling port:
#    ufw allow from 172.16.0.0/12 to any port 7880 proto tcp
#
# 1b. (RU servers) Docker Hub rate-limits anonymous pulls — use Timeweb's mirror:
#    echo '{ "registry-mirrors": ["https://dockerhub.timeweb.cloud"] }' > /etc/docker/daemon.json
#    systemctl restart docker

# 2. Clone both repos
mkdir -p /opt/shoom && cd /opt/shoom
git clone https://github.com/alexandrybkin-sudo/shoom.git
git clone https://github.com/alexandrybkin-sudo/shoom-backend.git
cd shoom-backend

# 3. Create secrets (NOT in git) — copy the template and fill real values
cp .env.example .env && nano .env

# 4. Point DNS: A records shoom.fun and livekit.shoom.fun -> server IP, then:
./deploy/init-letsencrypt.sh you@example.com

# 5. Bring everything up
docker compose up -d --build
```

## Updating (normal deploy)

```bash
cd /opt/shoom/shoom-backend && git pull
cd /opt/shoom/shoom && git pull
cd /opt/shoom/shoom-backend && docker compose up -d --build
```
