# PayMongo Backend Deployment (Hostinger KVM VPS)

This guide deploys the Node/Express API on an Ubuntu VPS using:

- `pm2` (process manager)
- `nginx` (reverse proxy)
- Let’s Encrypt (HTTPS)

## 0) Prereqs

- A Hostinger **KVM VPS** running **Ubuntu 22.04/24.04**
- A domain/subdomain pointing to the VPS IP (recommended)
  - Example: `api.yourdomain.com` -> `A record` -> `VPS_IP`
- SSH access

## 1) Server bootstrap

SSH into the server:

```bash
ssh root@VPS_IP
```

Create a non-root deploy user:

```bash
adduser deploy
usermod -aG sudo deploy
```

Enable firewall:

```bash
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw enable
```

Update packages:

```bash
apt update && apt -y upgrade
```

## 2) Install Node.js (LTS) + PM2

Install Node 20 LTS:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node -v
npm -v
```

Install PM2:

```bash
npm i -g pm2
pm2 -v
```

Enable PM2 on reboot:

```bash
pm2 startup
# run the command it prints (usually starts with sudo)
```

## 3) Deploy the code

Switch to the deploy user:

```bash
su - deploy
```

Clone the repo:

```bash
mkdir -p /var/www
cd /var/www
git clone https://github.com/Prince0643/paymongo-backend.git
cd paymongo-backend
```

Install dependencies:

```bash
npm ci --omit=dev
```

## 4) Configure environment variables

Create `.env` on the server:

```bash
nano /var/www/paymongo-backend/.env
```

Set at least:

- `PAYMONGO_SECRET_KEY=...`
- `TAX_RATE=0.10`
- `FRONTEND_SUCCESS_URL=...`
- `FRONTEND_FAILURE_URL=...`
- `FRONTEND_CANCEL_URL=...`
- `PORT=3000` (or whatever your app uses)

Notes:

- Do **not** commit `.env`.
- Prefer PayMongo **live** keys only on the VPS.

## 5) Start the app with PM2

Start (replace `server.js` with your actual entry file):

```bash
cd /var/www/paymongo-backend
pm2 start server.js --name paymongo-backend
pm2 save
pm2 status
```

Logs:

```bash
pm2 logs paymongo-backend
```

Restart after changes:

```bash
pm2 restart paymongo-backend
```

## 6) Nginx reverse proxy

Install Nginx:

```bash
sudo apt-get install -y nginx
```

Create a site config:

```bash
sudo nano /etc/nginx/sites-available/paymongo-backend
```

Example config (replace domain and port):

```nginx
server {
  server_name api.yourdomain.com;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Enable the config:

```bash
sudo ln -s /etc/nginx/sites-available/paymongo-backend /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 7) HTTPS (Let’s Encrypt)

Install certbot:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
```

Issue certificate:

```bash
sudo certbot --nginx -d api.yourdomain.com
```

## 8) PayMongo webhooks

Update your PayMongo dashboard webhook URL to your public endpoint, e.g.:

- `https://api.yourdomain.com/payments/webhook`

(Confirm the exact path based on your Express routes.)

## 9) Updating deployment

Pull the latest code and restart:

```bash
cd /var/www/paymongo-backend
git pull
npm ci --omit=dev
pm2 restart paymongo-backend
```

## 10) Quick troubleshooting

- Check app logs:

```bash
pm2 logs paymongo-backend
```

- Check Nginx:

```bash
sudo tail -n 200 /var/log/nginx/error.log
sudo nginx -t
sudo systemctl status nginx
```

- Check open port:

```bash
sudo ss -tulpn | grep 3000
```
