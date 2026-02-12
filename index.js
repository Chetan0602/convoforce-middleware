require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* ----------------------------------
   1️⃣ Test Route
-----------------------------------*/
app.get('/',(req,res) => {
    res.send('Convoforce Middleware Running ✅');
});

/* ----------------------------------
   2️⃣ Webhook Verification (GET)
-----------------------------------*/
app.get('/webhook',(req,res) => {
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

    const mode = req.query[ 'hub.mode' ];
    const token = req.query[ 'hub.verify_token' ];
    const challenge = req.query[ 'hub.challenge' ];

    if(mode && token === VERIFY_TOKEN) {
        console.log("Webhook Verified ✅");
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

/* ----------------------------------
   3️⃣ Receive Messages (POST)
-----------------------------------*/
app.post('/webhook',(req,res) => {
    console.log("Incoming Webhook:");
    console.log(JSON.stringify(req.body,null,2));
    res.sendStatus(200);
});

app.listen(PORT,() => {
    console.log(`Server running on port ${ PORT }`);
});
