#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logout, runAuthFlow } from "./auth.js";
import { loadConfig, loadOAuthClient, parseClientFile, paths } from "./config.js";
import { VERSION, createServer } from "./server.js";
import { writePrivateFile } from "./util.js";

const HELP = `youtube-playlist-mcp ${VERSION}

Usage:
  node dist/index.js                        Start the MCP server (stdio). This is what your MCP client runs.
  node dist/index.js auth [--client-file <client_secret.json>]
                                            Authorize access to your YouTube account (opens a browser).
                                            --client-file stores the OAuth client privately in the config dir,
                                            so you don't need GOOGLE_CLIENT_ID/SECRET in your MCP config.
  node dist/index.js logout                 Revoke access at Google and delete the local token.
  node dist/index.js status                 Show configuration status.
  node dist/index.js --help | --version

Environment (all optional):
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET    OAuth "Desktop app" client (alternative to --client-file)
  YOUTUBE_API_KEY                           Search-only mode without OAuth
  YOUTUBE_DAILY_QUOTA                       Your project's daily quota (default 10000)
  YOUTUBE_PLAYLIST_MCP_HOME                 Config directory (default ~/.config/youtube-playlist-mcp)
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const cfg = loadConfig();
  const out = (s: string) => process.stdout.write(s + "\n");

  switch (cmd) {
    case undefined:
    case "serve": {
      const server = createServer(cfg);
      await server.connect(new StdioServerTransport());
      // stdout belongs to the MCP protocol; diagnostics go to stderr only.
      console.error(`youtube-playlist-mcp ${VERSION} running on stdio`);
      return;
    }
    case "auth": {
      const i = rest.indexOf("--client-file");
      if (i !== -1) {
        const file = rest[i + 1];
        if (!file) throw new Error("--client-file needs a path");
        const client = parseClientFile(JSON.parse(await fs.readFile(path.resolve(file), "utf8")));
        await writePrivateFile(paths(cfg).client, JSON.stringify(client));
        out(`OAuth client saved to ${paths(cfg).client} (readable only by you).`);
        out(`You can now delete the downloaded file: ${path.resolve(file)}`);
      }
      const client = await loadOAuthClient(cfg);
      if (!client) {
        throw new Error("No OAuth client found. Pass --client-file <client_secret.json> or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
      }
      await runAuthFlow(cfg, client, out);
      out(`\n✓ Authorized. Token stored in ${paths(cfg).token} (readable only by you).`);
      out("Restart your MCP client (e.g. Claude Desktop) if it is already running.");
      return;
    }
    case "logout":
      out(await logout(cfg));
      return;
    case "status": {
      const client = await loadOAuthClient(cfg);
      const token = await fs.stat(paths(cfg).token).then(() => true, () => false);
      out(`Config dir:     ${cfg.homeDir}`);
      out(`OAuth client:   ${client ? "configured" : "missing"}`);
      out(`Authorized:     ${token ? "yes" : "no"}`);
      out(`API key:        ${cfg.apiKey ? "set" : "not set"}`);
      out(`Daily quota:    ${cfg.dailyQuota}`);
      return;
    }
    case "--version":
    case "-v":
      out(VERSION);
      return;
    case "--help":
    case "-h":
    case "help":
      out(HELP);
      return;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
