require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const querystring = require("querystring");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, MONGODB_PASSWORD } =
  process.env;

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI || !MONGODB_PASSWORD) {
  console.error("Missing required env variables.");
  process.exit(1);
}

const MONGODB_URI = `mongodb+srv://gaikwadvarun23:${encodeURIComponent(
  MONGODB_PASSWORD
)}@spotify-cluster.ckcsftr.mongodb.net/?retryWrites=true&w=majority`;

const client = new MongoClient(MONGODB_URI, {
  tls: true,
  useUnifiedTopology: true,
});

let tokensCollection;
let nowPlayingCollection;

let accessToken = "";
let refreshToken = "";

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function generateState(length = 16) {
  return crypto.randomBytes(length).toString("hex");
}

async function saveTokens() {
  try {
    await tokensCollection.updateOne(
      { _id: "user_tokens" },
      { $set: { accessToken, refreshToken } },
      { upsert: true }
    );
    log("Tokens saved to MongoDB.");
  } catch (e) {
    log("Error saving tokens:", e.message);
  }
}

async function loadTokens() {
  try {
    const doc = await tokensCollection.findOne({ _id: "user_tokens" });
    if (doc) {
      accessToken = doc.accessToken || "";
      refreshToken = doc.refreshToken || "";
      log("Tokens loaded from MongoDB.");
    } else {
      log("No tokens found in DB.");
    }
  } catch (e) {
    log("Error loading tokens:", e.message);
  }
}

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
    if (response.data.refresh_token) {
      refreshToken = response.data.refresh_token;
    }
    await saveTokens();
    log("Access token refreshed.");
    return true;
  } catch (error) {
    log(
      "Failed to refresh access token:",
      error.response?.data || error.message
    );
    return false;
  }
}

app.get("/login", (req, res) => {
  const scope = "user-read-currently-playing user-read-playback-state";
  const state = generateState();

  const authQuery = querystring.stringify({
    response_type: "code",
    client_id: CLIENT_ID,
    scope,
    redirect_uri: REDIRECT_URI,
    state,
  });

  const authUrl = `https://accounts.spotify.com/authorize?${authQuery}`;
  log("Redirecting to Spotify login.");
  res.redirect(authUrl);
});

app.get("/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send("Missing code or state");

  try {
    const tokenRes = await axios.post(
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

    accessToken = tokenRes.data.access_token;
    refreshToken = tokenRes.data.refresh_token;
    await saveTokens();

    res.send(
      `<html><body><h2>Login successful!</h2><p>You can close this window now.</p></body></html>`
    );
  } catch (error) {
    console.error("Callback error:", error.response?.data || error.message);
    res.status(500).send("Authentication failed");
  }
});

app.get("/current", async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: "Not authenticated" });

  async function fetchCurrent() {
    try {
      const response = await axios.get(
        "https://api.spotify.com/v1/me/player/currently-playing",
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (response.status === 204) {
        return res.json({
          playing: false,
          message: "No song currently playing",
        });
      }
      return res.json(response.data);
    } catch (err) {
      if (err.response?.status === 401 && refreshToken) {
        log("Access token expired, refreshing...");
        const refreshed = await refreshAccessToken();
        if (refreshed) return fetchCurrent();
        return res.status(401).json({ error: "Unauthorized, refresh failed" });
      }
      log("Error fetching current song:", err.response?.data || err.message);
      res.status(500).json({ error: "Failed to fetch current song" });
    }
  }

  return fetchCurrent();
});

// New endpoint: Receive now playing data and save to MongoDB
app.post("/update-now-playing", async (req, res) => {
  const songData = req.body;

  if (!songData || !songData.item) {
    return res.status(400).json({ error: "Invalid data: missing 'item'" });
  }

  try {
    await nowPlayingCollection.updateOne(
      { _id: "current_song" },
      { $set: songData },
      { upsert: true }
    );

    return res.json({ status: "success", message: "Now playing updated" });
  } catch (error) {
    console.error("Failed to update now playing:", error);
    return res.status(500).json({ error: "Database error" });
  }
});

(async () => {
  try {
    await client.connect();
    tokensCollection = client.db("spotify").collection("tokens");
    nowPlayingCollection = client.db("spotify").collection("now_playing");
    await loadTokens();
    log("Server starting on port", PORT);
    app.listen(PORT, () => {
      log(`Server running at http://localhost:${PORT}`);
      log(`Login endpoint: http://localhost:${PORT}/login`);
      log(
        `Now playing update endpoint: http://localhost:${PORT}/update-now-playing`
      );
    });
  } catch (e) {
    console.error("Failed to start server:", e);
    process.exit(1);
  }
})();
