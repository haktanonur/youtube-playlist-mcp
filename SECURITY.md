# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
[private vulnerability reporting](../../security/advisories/new) instead
(Security tab → "Report a vulnerability"). You should get a reply within 7 days.

## Design notes

- **Credentials never leave your machine except to Google.** The OAuth client, refresh token and quota ledger
  live in `~/.config/youtube-playlist-mcp/` (or `%APPDATA%\youtube-playlist-mcp\`). Files are `0600` and the directory is `0700`.
- **Never commit** `client_secret*.json`, `token.json` or `.env` files. The repository's `.gitignore` blocks them.
- **OAuth:** loopback redirect on `127.0.0.1` with a random port, PKCE S256, a 256-bit random `state` compared in constant time,
  a 5-minute timeout, and no reflected input in the callback page (strict CSP).
- **Least privilege:** only the `https://www.googleapis.com/auth/youtube` scope, which YouTube requires for playlist writes.
  There's no tool that deletes playlists, uploads, comments, likes or subscribes.
- **Human in the loop:** write tools require `confirm: true`, carry `destructiveHint`/`readOnlyHint` annotations,
  and their descriptions tell the agent to get explicit user approval first.
- **Prompt-injection hygiene:** YouTube titles, descriptions and tags are third-party content. They're sanitized
  (control and bidi characters removed, length-limited) and labeled as untrusted data in every tool result.
- **Input validation:** all IDs are checked against strict regexes before they reach the API, and every request
  uses URL-encoded parameters.
- **No shell execution** except opening the authorization URL in the browser, which uses `spawn` with an argument array and `shell: false`.
- **Supply chain:** two runtime dependencies (`@modelcontextprotocol/sdk`, `zod`), CI actions pinned by commit SHA,
  Dependabot enabled, and `npm audit` runs in CI.

## Revoking access

```bash
npm run logout   # from the project folder
```

Or remove the app at <https://myaccount.google.com/permissions>.
