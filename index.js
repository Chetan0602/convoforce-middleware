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

        const {
            phone_number_id,
            to,
            message,
            template_name,
            template_language,
            template_params
        } = req.body;

        if(!phone_number_id || !to) {
            return res.status(400).json({
                error: "phone_number_id and to required"
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

        let payload;

        // 🔹 TEMPLATE MESSAGE
        if(template_name) {

            payload = {
                messaging_product: "whatsapp",
                to: to,
                type: "template",
                template: {
                    name: template_name,
                    language: {
                        code: template_language || "en"
                    }
                }
            };

            // Add dynamic body parameters if provided
            if(template_params && Array.isArray(template_params)) {
                payload.template.components = [
                    {
                        type: "body",
                        parameters: template_params.map(param => ({
                            type: "text",
                            text: param
                        }))
                    }
                ];
            }

        }
        // 🔹 NORMAL TEXT MESSAGE
        else if(message) {

            payload = {
                messaging_product: "whatsapp",
                to: to,
                type: "text",
                text: {body: message}
            };

        } else {
            return res.status(400).json({
                error: "Either message or template_name required"
            });
        }

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
/* ----------------------------------
   Get Media URL From Meta
-----------------------------------*/
app.get('/media/:mediaId',async (req,res) => {
    try {

        const {mediaId} = req.params;

        if(!mediaId) {
            return res.status(400).send("mediaId required");
        }

        const metaResponse = await axios.get(
            `https://graph.facebook.com/${ process.env.META_API_VERSION }/${ mediaId }`,
            {
                headers: {
                    Authorization: `Bearer ${ process.env.META_ACCESS_TOKEN }`
                }
            }
        );

        const mediaUrl = metaResponse.data.url;

        if(!mediaUrl) {
            return res.status(404).send("Media URL not found");
        }

        // 🔥 Return ONLY URL (same as old Apex behavior)
        return res.status(200).send(mediaUrl);

    } catch(error) {

        console.error("Media Fetch Error:",
            error.response?.data || error.message);

        return res.status(500).send("Failed to fetch media");
    }
});
/* ----------------------------------
   Download Media Proxy (For Apex)
-----------------------------------*/
app.get('/download',async (req,res) => {
    try {

        const {url} = req.query;

        if(!url) {
            return res.status(400).send("media url required");
        }

        console.log("Downloading from Meta:",url);

        const mediaResponse = await axios.get(url,{
            headers: {
                Authorization: `Bearer ${ process.env.META_ACCESS_TOKEN }`
            },
            responseType: 'stream'
        });

        // Forward content type to Apex
        res.setHeader(
            'Content-Type',
            mediaResponse.headers[ 'content-type' ] || 'application/octet-stream'
        );

        // Stream file back to Apex
        mediaResponse.data.pipe(res);

    } catch(error) {

        console.error(
            "Download Error:",
            error.response?.data || error.message
        );

        res.status(500).send("Failed to download media");
    }
});
/* ----------------------------------
   Send Media (Proxy + Validation)
-----------------------------------*/
app.post('/send-media',async (req,res) => {
    try {

        const {phone_number_id,payload} = req.body;

        // 🔹 Basic Validation
        if(!phone_number_id) {
            return res.status(400).json({
                error: "phone_number_id required"
            });
        }

        if(!payload || typeof payload !== 'object') {
            return res.status(400).json({
                error: "Valid payload required"
            });
        }

        // 🔹 Customer Exists Check
        const customer = customers[ phone_number_id ];

        if(!customer) {
            return res.status(404).json({
                error: "Customer not found"
            });
        }

        // 🔹 Required WhatsApp Fields Check
        if(!payload.messaging_product || !payload.to || !payload.type) {
            return res.status(400).json({
                error: "Invalid WhatsApp payload"
            });
        }

        console.log(`Sending media for ${ customer.name }`);

        // 🔹 Build Meta Endpoint
        const endpoint =
            `https://graph.facebook.com/${ process.env.META_API_VERSION }/${ phone_number_id }/messages`;

        // 🔹 Forward To Meta
        const response = await axios.post(endpoint,payload,{
            headers: {
                Authorization: `Bearer ${ process.env.META_ACCESS_TOKEN }`,
                'Content-Type': 'application/json'
            }
        });

        // 🔥 Return Meta response directly to Apex
        return res.status(200).json(response.data);

    } catch(error) {

        console.error(
            "Send Media Error:",
            error.response?.data || error.message
        );

        return res.status(500).json(
            error.response?.data || {error: "Meta call failed"}
        );
    }
});
app.listen(PORT,() => {
    console.log(`Server running on port ${ PORT }`);
});