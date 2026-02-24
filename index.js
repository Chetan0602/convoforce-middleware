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
/* ----------------------------------
   Get Business Verified Name
-----------------------------------*/
app.post('/getVerifiedName',async (req,res) => {

    const {phoneNumberId} = req.body;

    try {

        const accessToken = process.env.META_ACCESS_TOKEN;

        // 🔥 IMPORTANT: /phone_numbers edge use karo
        const response = await axios.get(
            `https://graph.facebook.com/v19.0/${ phoneNumberId }/phone_numbers`,
            {
                params: {
                    access_token: accessToken
                }
            }
        );

        const metaData = response.data;

        if(!metaData.data || metaData.data.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No phone number found"
            });
        }

        const phoneData = metaData.data[ 0 ];

        res.json({
            success: true,
            verified_name: phoneData.verified_name,
            display_phone_number: phoneData.display_phone_number,
            code_verification_status: phoneData.code_verification_status,
            full_response: metaData // optional debug
        });

    } catch(error) {

        console.error("Meta Error:",error.response?.data || error.message);

        res.status(500).json({
            success: false,
            error: error.response?.data || error.message
        });
    }
});
/* ----------------------------------
   Create Template
-----------------------------------*/
app.post('/create-template',async (req,res) => {

    const {wabaId,payload} = req.body;

    if(!wabaId || !payload) {
        return res.json({
            success: false,
            message: "wabaId and payload are required"
        });
    }

    try {

        const accessToken = process.env.META_ACCESS_TOKEN;

        const response = await axios.post(
            `https://graph.facebook.com/v19.0/${ wabaId }/message_templates`,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${ accessToken }`,
                    'Content-Type': 'application/json'
                }
            }
        );

        // ✅ Always return full Meta response
        return res.json({
            success: true,
            metaResponse: response.data
        });

    } catch(error) {

        // 🔥 Important: capture full error response
        const fullError =
            error.response?.data || error.message;

        console.error("Meta Template Error:",fullError);

        return res.json({
            success: false,
            metaError: fullError
        });
    }
});

/* ----------------------------------
   Upload Media (Dynamic Header)
-----------------------------------*/
app.post('/upload-media',async (req,res) => {

    const {fileName,fileBase64} = req.body;

    if(!fileName || !fileBase64) {
        return res.status(400).json({
            success: false,
            message: "fileName and fileBase64 are required"
        });
    }

    try {

        const accessToken = process.env.META_ACCESS_TOKEN;
        const apiVersion = process.env.META_API_VERSION;
        const appId = process.env.META_APP_ID;

        // 🔎 Detect content type
        const ext = fileName.split('.').pop().toLowerCase();
        let contentType;

        if([ 'jpg','jpeg','png' ].includes(ext)) {
            contentType = `image/${ ext === 'jpg' ? 'jpeg' : ext }`;
        }
        else if(ext === 'mp4') {
            contentType = 'video/mp4';
        }
        else if(ext === 'pdf') {
            contentType = 'application/pdf';
        }
        else {
            return res.status(400).json({
                success: false,
                message: "Unsupported file type"
            });
        }

        const fileBuffer = Buffer.from(fileBase64,'base64');

        /* -------------------------------
           STEP 1 → Create Upload Session
        --------------------------------*/
        const sessionResponse = await axios.post(
            `https://graph.facebook.com/${ apiVersion }/${ appId }/uploads`,
            null,
            {
                params: {
                    file_length: fileBuffer.length,
                    file_type: contentType
                },
                headers: {
                    Authorization: `Bearer ${ accessToken }`
                }
            }
        );

        const sessionId = sessionResponse.data.id;

        /* -------------------------------
           STEP 2 → Upload File
        --------------------------------*/
        const uploadResponse = await axios.post(
            `https://graph.facebook.com/${ apiVersion }/${ sessionId }`,
            fileBuffer,
            {
                headers: {
                    Authorization: `Bearer ${ accessToken }`,
                    'Content-Type': 'application/octet-stream'
                }
            }
        );

        const handle = uploadResponse.data.h;

        if(!handle) {
            return res.status(500).json({
                success: false,
                message: "Meta returned empty media handle"
            });
        }

        // ✅ Return handle to Salesforce
        return res.status(200).json({
            success: true,
            mediaHandle: handle,
            metaResponse: uploadResponse.data
        });

    } catch(error) {

        const fullError =
            error.response?.data || error.message;

        const statusCode =
            error.response?.status || 500;

        console.error("Meta Media Upload Error:",fullError);

        return res.status(statusCode).json({
            success: false,
            metaError: fullError
        });
    }
});

app.listen(PORT,() => {
    console.log(`Server running on port ${ PORT }`);
});