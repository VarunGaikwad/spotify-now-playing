require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const querystring = require("querystring");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());

// File where tokens are stored
const TOKEN_FILE = path.join(__dirname, "tokens.json");

// Default tokens in memory
let accessToken = "";
let refreshToken = "";

// Load tokens from disk
function loadTokens() {
  try {
    const raw = fs.readFileSync(TOKEN_FILE);
    const tokens = JSON.parse(raw);
    accessToken = tokens.accessToken || "";
    refreshToken = tokens.refreshToken || "";
    console.log("Tokens loaded from file.");
  } catch (e) {
    console.log("No tokens file found, starting fresh.");
    accessToken = "";
    refreshToken = "";
  }
}

// Save tokens to disk
function saveTokens() {
  fs.writeFileSync(
    TOKEN_FILE,
    JSON.stringify({ accessToken, refreshToken }, null, 2)
  );
}

// Load tokens on startup
loadTokens();

// Environment variables
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

// Step 1: Redirect user to Spotify login
app.get("/login", (req, res) => {
  const scope = "user-read-currently-playing user-read-playback-state";
  const returnTo = req.query.returnTo;

  const queryParams = querystring.stringify({
    response_type: "code",
    client_id: CLIENT_ID,
    scope: scope,
    redirect_uri: REDIRECT_URI,
    state: encodeURIComponent(returnTo || ""), // pass frontend URL safely
  });

  res.redirect(`https://accounts.spotify.com/authorize?${queryParams}`);
});

// Step 2: Handle redirect from Spotify after login
app.get("/callback", async (req, res) => {
  const code = req.query.code || null;
  const returnTo = decodeURIComponent(req.query.state || "");

  try {
    const response = await axios.post(
      "https://accounts.spotify.com/api/token",
      querystring.stringify({
        grant_type: "authorization_code",
        code: code,
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

    accessToken = response.data.access_token;
    refreshToken = response.data.refresh_token;

    saveTokens();

    if (returnTo) {
      return res.redirect(returnTo); // redirect back to your frontend
    } else {
      return res.send(`<h2>✅ Logged in! You can close this tab.</h2>`);
    }
  } catch (error) {
    console.error("Callback error:", error.response?.data || error.message);
    res.status(500).send("Authentication failed");
  }
});

async function refreshAccessToken() {
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
    saveTokens(); // persist updated token
    console.log("✅ Access token refreshed.");
    return true;
  } catch (error) {
    console.error(
      "Failed to refresh access token:",
      error.response?.data || error.message
    );
    return false;
  }
}

// Step 3: Get currently playing song
app.get("/current", async (req, res) => {
  if (!accessToken) {
    return res.status(401).json({ error: "User not authenticated" });
  }

  try {
    const response = await axios.get(
      "https://api.spotify.com/v1/me/player/currently-playing",
      {
        headers: {
          Authorization: "Bearer " + accessToken,
        },
      }
    );

    return res.status(response.status).json(response.data);
  } catch (err) {
    if (err.response?.status === 401 && refreshToken) {
      console.log("⚠️ Access token expired, attempting refresh...");
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        try {
          const retry = await axios.get(
            "https://api.spotify.com/v1/me/player/currently-playing",
            {
              headers: {
                Authorization: "Bearer " + accessToken,
              },
            }
          );
          return res.status(retry.status).json(retry.data);
        } catch (e) {
          console.error("Failed after refresh:", e.response?.data || e.message);
          return res.status(500).json({ error: "Failed after token refresh" });
        }
      }
    }

    console.error(
      "Error fetching current song:",
      err.response?.data || err.message
    );
    res.status(500).json({ error: "Failed to fetch current song" });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Login at http://localhost:${PORT}/login`);
});
