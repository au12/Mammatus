# Public access through a reverse proxy

Mammatus is designed to sit behind an HTTPS reverse proxy. HTTPS is required for remote sign-in cookies,
for installing the app on phones, and for push notifications.

## Nginx Proxy Manager (Unraid)

1. **Proxy Hosts → Add Proxy Host**
   - Domain: `wx.example.com`
   - Scheme `http`, Forward Hostname/IP: your Unraid IP (e.g. `10.0.10.10`), Forward Port: `8080`
   - Enable **Block Common Exploits** and **Websockets Support** (harmless; Mammatus uses Server-Sent Events, which also need buffering off — see below)
2. **SSL** tab: request a Let's Encrypt certificate, enable **Force SSL**, **HTTP/2** and **HSTS** if you like.
3. **Advanced** tab, paste:

   ```nginx
   # live updates (Server-Sent Events) must not be buffered
   location /api/events {
       proxy_pass http://10.0.10.10:8080;
       proxy_http_version 1.1;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_buffering off;
       proxy_cache off;
       proxy_read_timeout 1h;
   }
   client_max_body_size 1m;
   ```

4. In the Mammatus container settings set:
   - `MAMMATUS_PUBLIC_URL=https://wx.example.com` (invite links, secure cookies, push contact)
   - `MAMMATUS_TRUSTED_PROXIES=10.0.10.2/32` — the IP of the NPM container/host, so only it may set
     `X-Forwarded-For`. The default trusts private networks, which is fine on a typical LAN.
   - Optionally `MAMMATUS_HSTS=true` once you only ever reach Mammatus over HTTPS.

## What Mammatus does on its own

- **Accounts**: invite-only. The first admin is created with a one-time code from the container log
  (or `MAMMATUS_ADMIN_USER` / `MAMMATUS_ADMIN_PASSWORD`). Admins create single-use invite links in
  Settings → Users; there is no open sign-up.
- **Passwords** are hashed with scrypt; sessions are random 256-bit tokens stored only as SHA-256 digests,
  in `HttpOnly`, `SameSite=Lax`, `__Host-` cookies when served over HTTPS.
- **Two-step verification** (TOTP) per user, with replay protection. Recommended for anything public.
- **Brute-force limits** per IP and per account on sign-in, TOTP and registration; API rate limits per user.
- **CSRF**: every state-changing request needs the `X-Mammatus` header and a same-origin `Origin`.
- **Headers**: strict Content-Security-Policy (no inline scripts), `X-Frame-Options: DENY`, COOP/CORP,
  `nosniff`, a restrictive Permissions-Policy, optional HSTS. Request bodies are capped at 256 KB.
- **Audit log** of sign-ins, failures, password/2FA changes and admin actions (Settings → System).
- The container runs as an unprivileged user (`PUID`/`PGID`, default 99:100) with a single `/data` volume.

## Optional extra hardening in NPM

- **Access List** with "Satisfy any" plus your LAN, if you want to restrict by country/IP.
- Rate limiting at the proxy for `/api/auth/` if your proxy supports it.
- Fail2ban can watch the audit events (`login_failed`) in the container log.
