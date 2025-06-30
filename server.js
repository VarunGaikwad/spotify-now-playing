require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const querystring = require("querystring");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());

// File where tokens are stored (add to .gitignore!)
const TOKEN_FILE = path.join(__dirname, "tokens.json");

// In-memory token storage
let accessToken = "";
let refreshToken = "";

// In-memory state store for CSRF protection & redirect URLs
const stateStore = new Map();

// Load tokens from disk on startup
function loadTokens() {
  try {
    const raw = fs.readFileSync(TOKEN_FILE, "utf-8");
    const tokens = JSON.parse(raw);
    accessToken = tokens.accessToken || "";
    refreshToken = tokens.refreshToken || "";
    log("Tokens loaded from file.");
  } catch (e) {
    log("No tokens file found, starting fresh.");
  }
}

// Save tokens to disk
function saveTokens() {
  try {
    fs.writeFileSync(
      TOKEN_FILE,
      JSON.stringify({ accessToken, refreshToken }, null, 2),
      "utf-8"
    );
  } catch (e) {
    log("Error saving tokens:", e.message);
  }
}

// Simple logger with timestamps
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// Generate random string for state
function generateState(length = 16) {
  return crypto.randomBytes(length).toString("hex");
}

// Environment variables
const { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI } = process.env;

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
  log(
    "Error: Missing required environment variables CLIENT_ID, CLIENT_SECRET, or REDIRECT_URI"
  );
  process.exit(1);
}

loadTokens();

/**
 * Spotify Authorization URL
 */
app.get("/login", (req, res) => {
  const scope = "user-read-currently-playing user-read-playback-state";
  const returnTo = req.query.returnTo || "";

  const state = generateState();
  // Save state and returnTo for validation on callback
  stateStore.set(state, returnTo);

  const queryParams = querystring.stringify({
    response_type: "code",
    client_id: CLIENT_ID,
    scope,
    redirect_uri: REDIRECT_URI,
    state,
  });

  const authUrl = `https://accounts.spotify.com/authorize?${queryParams}`;
  log("Redirecting to Spotify login:", authUrl);
  res.redirect(authUrl);
});

/**
 * Spotify OAuth callback handler
 */
app.get("/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.status(400).send("Missing code or state");
  }

  // Validate the state parameter to protect against CSRF
  if (!stateStore.has(state)) {
    return res.status(400).send("Invalid state");
  }

  // Retrieve the return URL and remove state from store
  const returnTo = stateStore.get(state) || "/";
  stateStore.delete(state);

  try {
    // Exchange authorization code for access and refresh tokens
    const tokenResponse = await axios.post(
      "https://accounts.spotify.com/api/token",
      querystring.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
      {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    // Save tokens in memory and persist to file
    accessToken = tokenResponse.data.access_token;
    refreshToken = tokenResponse.data.refresh_token;
    saveTokens();

    // Send a small page that:
    // - posts a message to the opener window notifying success
    // - closes the popup window automatically
    // - fallback redirects if opener doesn't exist
    return res.send(`
      <html>
        <body>
          <script>
            (function() {
              const returnTo = ${JSON.stringify(returnTo)};
              if (window.opener) {
                window.opener.postMessage({ type: "SPOTIFY_LOGIN_SUCCESS", returnTo }, "*");
                window.close();
              } else {
                window.location.href = returnTo;
              }
            })();
          </script>
          <p>Login successful! You can close this window.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Callback error:", error.response?.data || error.message);
    return res.status(500).send("Authentication failed");
  }
});

/**
 * Refresh Spotify access token using refresh token
 */
async function refreshAccessToken() {
  if (!refreshToken) {
    log("No refresh token available.");
    return false;
  }

  try {
    const response = await axios.post(
      "https://accounts.spotify.com/api/token",
      querystring.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    accessToken = response.data.access_token;
    // Spotify may not always return a new refresh token
    if (response.data.refresh_token) {
      refreshToken = response.data.refresh_token;
    }

    saveTokens();
    log("✅ Access token refreshed.");
    return true;
  } catch (error) {
    log(
      "Failed to refresh access token:",
      error.response?.data || error.message
    );
    return false;
  }
}

/**
 * Helper to delay execution for ms milliseconds
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get currently playing track
 */
app.get("/current", async (req, res) => {
  if (!accessToken) {
    return res.status(401).json({ error: "User not authenticated" });
  }

  async function fetchCurrent() {
    try {
      const response = await axios.get(
        "https://api.spotify.com/v1/me/player/currently-playing",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      // Spotify returns 204 No Content if nothing is playing
      if (response.status === 204) {
        return res.json({
          playing: false,
          message: "No song currently playing",
        });
      }

      return res.status(response.status).json(response.data);
    } catch (err) {
      if (err.response) {
        const status = err.response.status;

        if (status === 401 && refreshToken) {
          log("⚠️ Access token expired, refreshing...");
          const refreshed = await refreshAccessToken();
          if (refreshed) {
            return fetchCurrent(); // retry once
          }
          return res
            .status(401)
            .json({ error: "Unauthorized, token refresh failed" });
        }

        if (status === 429) {
          const retryAfter = parseInt(err.response.headers["retry-after"]) || 1;
          log(`Rate limited. Retrying after ${retryAfter} seconds...`);
          await delay(retryAfter * 1000);
          return fetchCurrent(); // retry after delay
        }
      }

      log("Error fetching current song:", err.response?.data || err.message);
      return res.status(500).json({ error: "Failed to fetch current song" });
    }
  }

  return fetchCurrent();
});

// Start the server
app.listen(PORT, () => {
  log(`Server running at http://localhost:${PORT}`);
  log(`Login endpoint: http://localhost:${PORT}/login`);
});
