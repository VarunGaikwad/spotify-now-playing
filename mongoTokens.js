const { MongoClient } = require("mongodb");

const uri = `mongodb+srv://gaikwadvarun23:${MONGODB_PASSWORD}@spotify-cluster.ckcsftr.mongodb.net/?retryWrites=true&w=majority&appName=Spotify-Cluster`;
const client = new MongoClient(uri);

let accessToken = "";
let refreshToken = "";

async function connectDB() {
  if (!client.isConnected()) await client.connect();
  return client.db("spotify").collection("tokens");
}

// Load tokens from MongoDB
async function loadTokens() {
  const collection = await connectDB();
  const tokens = await collection.findOne({ _id: "user_tokens" });
  if (tokens) {
    accessToken = tokens.accessToken || "";
    refreshToken = tokens.refreshToken || "";
    console.log("Tokens loaded from MongoDB");
  } else {
    console.log("No tokens found in MongoDB, starting fresh.");
  }
}

// Save tokens to MongoDB
async function saveTokens() {
  const collection = await connectDB();
  await collection.updateOne(
    { _id: "user_tokens" },
    { $set: { accessToken, refreshToken } },
    { upsert: true }
  );
  console.log("Tokens saved to MongoDB");
}

module.exports = {
  loadTokens,
  saveTokens,
  getAccessToken: () => accessToken,
  setAccessToken: (token) => (accessToken = token),
  getRefreshToken: () => refreshToken,
  setRefreshToken: (token) => (refreshToken = token),
};
