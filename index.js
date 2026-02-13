require('dotenv').config();
const express = require('express');
const axios = require('axios');

const customers = require('./customers.json');

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
   2️⃣ Meta Webhook Verification
-----------------------------------*/
app.get('/webhook',(req,res) => {

    const mode = req.query[ 'hub.mode' ];
    const token = req.query[ 'hub.verify_token' ];
    const challenge = req.query[ 'hub.challenge' ];

    if(mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
        console.log('Webhook Verified ✅');
        return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
});

/* ----------------------------------
   3️⃣ Receive Messages From Meta
-----------------------------------*/
app.post('/webhook',async (req,res) => {
    try {

        const phoneNumberId =
            req.body.entry?.[ 0 ]?.changes?.[ 0 ]?.value?.metadata?.phone_number_id;

        if(!phoneNumberId) {
            console.log("No phone_number_id found");
            return res.sendStatus(200);
        }

        const customer = customers[ phoneNumberId ];

        if(!customer) {
            console.log("Customer not found:",phoneNumberId);
            return res.sendStatus(200);
        }

        console.log(`Routing to ${ customer.name }`);

        // Forward full payload to customer org
        await axios.post(customer.webhook_url,req.body,{
            headers: {
                'Content-Type': 'application/json',
                'X-Source': 'Convoforce-Middleware',
                'X-Secret': process.env.INTERNAL_SECRET
            }
        });

        res.sendStatus(200);

    } catch(error) {
        console.error("Webhook Error:",
            error.response?.data || error.message);
        res.sendStatus(500);
    }
});

/* ----------------------------------
   4️⃣ Send Message
   Customer → Middleware → Meta
-----------------------------------*/
app.post('/send',async (req,res) => {
    try {

        const {phone_number_id,to,message} = req.body;

        if(!phone_number_id || !to || !message) {
            return res.status(400).json({
                error: "phone_number_id, to, message required"
            });
        }

        const customer = customers[ phone_number_id ];

        if(!customer) {
            return res.status(404).json({
                error: "Customer not found"
            });
        }

        const endpoint =
            `https://graph.facebook.com/${ process.env.META_API_VERSION }/${ phone_number_id }/messages`;

        const payload = {
            messaging_product: "whatsapp",
            to: to,
            type: "text",
            text: {body: message}
        };

        const response = await axios.post(endpoint,payload,{
            headers: {
                'Authorization': `Bearer ${ process.env.META_ACCESS_TOKEN }`,
                'Content-Type': 'application/json'
            }
        });

        return res.status(200).json(response.data);

    } catch(error) {
        console.error("Send Error:",
            error.response?.data || error.message);

        return res.status(500).json({
            error: "Failed to send message"
        });
    }
});

app.listen(PORT,() => {
    console.log(`Server running on port ${ PORT }`);
});