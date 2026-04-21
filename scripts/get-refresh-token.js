#!/usr/bin/env node
/**
 * One-time script to generate a Gmail OAuth refresh token.
 *
 * Usage:
 *   1. Set your Client ID and Client Secret from Google Cloud Console
 *   2. Run: node scripts/get-refresh-token.js
 *   3. Open the URL it prints in your browser
 *   4. Sign in as carlie@lakerootscl.com and authorize
 *   5. You'll be redirected to localhost — the script captures the code
 *   6. Copy the refresh_token it prints into Netlify env vars
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

// ── PASTE YOUR CREDENTIALS HERE (or set as env vars) ───────
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "PASTE_CLIENT_ID_HERE";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "PASTE_CLIENT_SECRET_HERE";
const REDIRECT_URI = "http://localhost:3000/callback";
const SCOPES = "https://www.googleapis.com/auth/gmail.modify";

// ── BUILD AUTH URL ──────────────────────────────────────────
const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
  }).toString();

console.log("\n╔══════════════════════════════════════════════════════════╗");
console.log("║           Gmail OAuth Refresh Token Generator           ║");
console.log("╚══════════════════════════════════════════════════════════╝\n");
console.log("1. Open this URL in your browser:\n");
console.log(`   ${authUrl}\n`);
console.log("2. Sign in as carlie@lakerootscl.com");
console.log("3. Click 'Allow' to grant Gmail access");
console.log("4. You'll be redirected — this script will capture the token\n");
console.log("Waiting for callback on http://localhost:3000 ...\n");

// ── LOCAL SERVER TO CAPTURE CALLBACK ────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:3000");

  if (!url.pathname.startsWith("/callback")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    console.error(`\nERROR: ${error}`);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h2>Error: " + error + "</h2><p>Check the terminal.</p>");
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400);
    res.end("No code received");
    return;
  }

  console.log("Authorization code received — exchanging for tokens...\n");

  // Exchange code for tokens
  try {
    const tokenBody = new URLSearchParams({
      code: code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }).toString();

    const tokenData = await new Promise((resolve, reject) => {
      const tokenReq = https.request(
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(tokenBody),
          },
        },
        (tokenRes) => {
          let data = "";
          tokenRes.on("data", (chunk) => (data += chunk));
          tokenRes.on("end", () => {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error(data)); }
          });
        }
      );
      tokenReq.on("error", reject);
      tokenReq.write(tokenBody);
      tokenReq.end();
    });

    if (tokenData.error) {
      throw new Error(`${tokenData.error}: ${tokenData.error_description}`);
    }

    console.log("╔══════════════════════════════════════════════════════════╗");
    console.log("║                    SUCCESS!                              ║");
    console.log("╚══════════════════════════════════════════════════════════╝\n");
    console.log("Your refresh token:\n");
    console.log(`   ${tokenData.refresh_token}\n`);
    console.log("────────────────────────────────────────────────────────────");
    console.log("Copy this value and add it to Netlify env vars as:");
    console.log("   GOOGLE_REFRESH_TOKEN = (the value above)\n");
    console.log("Also add these to Netlify env vars:");
    console.log(`   GOOGLE_CLIENT_ID = ${CLIENT_ID}`);
    console.log(`   GOOGLE_CLIENT_SECRET = ${CLIENT_SECRET}\n`);

    if (tokenData.access_token) {
      console.log("Access token (temporary, expires in ~1 hour):");
      console.log(`   ${tokenData.access_token.slice(0, 30)}...\n`);
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<html><body style='font-family:sans-serif;max-width:600px;margin:40px auto;text-align:center;'>" +
      "<h2 style='color:#2E7D32;'>Gmail Authorization Complete!</h2>" +
      "<p>Your refresh token has been printed in the terminal.</p>" +
      "<p>You can close this tab and go back to the terminal.</p>" +
      "</body></html>"
    );
  } catch (e) {
    console.error(`\nERROR exchanging code: ${e.message}`);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h2>Error exchanging code</h2><p>" + e.message + "</p>");
  }

  server.close();
  setTimeout(() => process.exit(0), 500);
});

server.listen(3000, () => {});
