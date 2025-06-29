// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const querystring = require('querystring');

const app = express();
const PORT = 3001;

app.use(cors());

let accessToken = '';
let refreshToken = '';

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

// Step 1: Redirect user to Spotify login
app.get('/login', (req, res) => {
    const scope = 'user-read-currently-playing user-read-playback-state';

    const queryParams = querystring.stringify({
        response_type: 'code',
        client_id: CLIENT_ID,
        scope: scope,
        redirect_uri: REDIRECT_URI,
    });

    res.redirect(`https://accounts.spotify.com/authorize?${queryParams}`);
});

// Step 2: Spotify redirects here with auth code
app.get('/callback', async (req, res) => {
    const code = req.query.code || null;

    try {
        const response = await axios.post(
            'https://accounts.spotify.com/api/token',
            querystring.stringify({
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI,
            }),
            {
                headers: {
                    Authorization:
                        'Basic ' +
                        Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            }
        );

        accessToken = response.data.access_token;
        refreshToken = response.data.refresh_token;

        res.send(`<h2>Logged in! You can close this tab.</h2>`);
    } catch (error) {
        console.error(error.response.data);
        res.status(500).send('Authentication failed');
    }
});

// Step 3: Endpoint to get currently playing song
app.get('/current', async (req, res) => {
    if (!accessToken) {
        return res.status(401).json({ error: 'User not authenticated' });
    }

    try {
        const response = await axios.get(
            'https://api.spotify.com/v1/me/player/currently-playing',
            {
                headers: {
                    Authorization: 'Bearer ' + accessToken,
                },
            }
        );

        if (response.status === 204 || !response.data?.item) {
            return res.json({ playing: false });
        }

        const item = response.data.item;

        res.json({
            playing: true,
            song: {
                name: item.name,
                artist: item.artists.map((a) => a.name).join(', '),
                album: item.album.name,
                artwork: item.album.images[0]?.url,
            },
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Failed to fetch current song' });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Login at http://localhost:${PORT}/login`);
});
