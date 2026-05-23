# Docker Compose Secrets

`docker-compose.yml` reads these local files as Docker secrets:

- `postgres_password.txt`: required, PostgreSQL password.
- `panel_password.txt`: optional, leave the file empty for passwordless panel mode.
- `panel_session_secret.txt`: recommended, fixed random value used to sign panel sessions.
- `kris_agent_token.txt`: optional, leave the file empty to disable kris-agent report ingestion.

These `*.txt` files are ignored by Git. Create them before running Docker Compose.

PowerShell example:

```powershell
New-Item -ItemType Directory -Force secrets
Set-Content -NoNewline secrets/postgres_password.txt "replace-with-db-password"
Set-Content -NoNewline secrets/panel_password.txt "replace-with-panel-password-or-empty"
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" | Set-Content -NoNewline secrets/panel_session_secret.txt
Set-Content -NoNewline secrets/kris_agent_token.txt "replace-with-agent-token-or-empty"
```

In this setup `docker inspect` shows only `_FILE` paths such as `/run/secrets/postgres_password`, not the secret values.
