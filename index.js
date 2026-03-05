require('dotenv').config();
const express = require('express');
const axios = require('axios');

const customers = require('./customers.json');

const app = express();

/* ----------------------------------
   🔥 VERY IMPORTANT — Increase Limit
-----------------------------------*/
app.use(express.json({limit: '100mb'}));
app.use(express.urlencoded({limit: '100mb',extended: true}));

const PORT = process.env.PORT || 3000;

app.listen(PORT,() => {
    console.log(`Server running on port ${ PORT }`);
});
/* ----------------------------------
   1️⃣ Test Route
-----------------------------------*/
app.get('/',(req,res) => {
    res.send('Convoforce Middleware Running ✅');
});
/* ----------------------------------
    wake
-----------------------------------*/
app.get("/wake",(req,res) => {
    res.send("Server Awake");
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
            await handlePhoneNotFound(
                "phone_number_id missing",
                req.body
            );
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
   4️⃣ Send Template Message → Middleware → Meta
-----------------------------------*/
app.post("/send-template",async (req,res) => {

    try {

        const {phoneNumberId,payload} = req.body;

        // 🔹 Validation
        if(!phoneNumberId) {
            return res.status(400).json({
                success: false,
                message: "phoneNumberId is required"
            });
        }

        if(!payload) {
            return res.status(400).json({
                success: false,
                message: "payload is required"
            });
        }

        if(!payload.to) {
            return res.status(400).json({
                success: false,
                message: "Recipient phone number missing"
            });
        }

        // 🔹 Ensure messaging product exists
        payload.messaging_product = "whatsapp";

        // 🔹 Meta Graph API endpoint
        const endpoint =
            `https://graph.facebook.com/${ process.env.META_API_VERSION }/${ phoneNumberId }/messages`;

        console.log("---------- SEND TEMPLATE REQUEST ----------");
        console.log("Phone Number ID:",phoneNumberId);
        console.log("Payload:",JSON.stringify(payload,null,2));

        const response = await axios.post(
            endpoint,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${ process.env.META_ACCESS_TOKEN }`,
                    "Content-Type": "application/json"
                }
            }
        );

        console.log("---------- META RESPONSE ----------");
        console.log(JSON.stringify(response.data,null,2));

        return res.status(200).json({
            success: true,
            data: response.data
        });

    } catch(error) {

        console.error("---------- META ERROR ----------");

        if(error.response) {
            console.error(JSON.stringify(error.response.data,null,2));

            return res.status(error.response.status).json({
                success: false,
                error: error.response.data
            });
        }

        console.error(error.message);

        return res.status(500).json({
            success: false,
            message: "Internal server error"
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
        const apiVersion = process.env.META_API_VERSION || 'v19.0';
        const appId = process.env.META_APP_ID;

        if(!accessToken || !appId) {
            return res.status(500).json({
                success: false,
                message: "Server configuration missing (META_ACCESS_TOKEN or META_APP_ID)"
            });
        }

        /* ----------------------------------
           Detect Content Type
        -----------------------------------*/
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

        /* ----------------------------------
           Clean Base64 (VERY IMPORTANT)
        -----------------------------------*/
        const cleanedBase64 = fileBase64.includes('base64,')
            ? fileBase64.split('base64,')[ 1 ]
            : fileBase64;

        const fileBuffer = Buffer.from(cleanedBase64,'base64');

        console.log("Uploading file:");
        console.log("File Name:",fileName);
        console.log("File Size (bytes):",fileBuffer.length);
        console.log("Content Type:",contentType);

        /* ----------------------------------
           STEP 1 → Create Upload Session
        -----------------------------------*/
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

        if(!sessionId) {
            return res.status(500).json({
                success: false,
                message: "Meta did not return upload session ID",
                metaResponse: sessionResponse.data
            });
        }

        /* ----------------------------------
           STEP 2 → Upload File
        -----------------------------------*/
        const uploadResponse = await axios.post(
            `https://graph.facebook.com/${ apiVersion }/${ sessionId }`,
            fileBuffer,
            {
                headers: {
                    Authorization: `Bearer ${ accessToken }`,
                    'Content-Type': 'application/octet-stream'
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            }
        );

        const handle = uploadResponse.data.h;

        if(!handle) {
            return res.status(500).json({
                success: false,
                message: "Meta returned empty media handle",
                metaResponse: uploadResponse.data
            });
        }

        console.log("Media uploaded successfully. Handle:",handle);

        /* ----------------------------------
           SUCCESS RESPONSE
        -----------------------------------*/
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

        console.error("Meta Media Upload Error:");
        console.error(JSON.stringify(fullError,null,2));

        return res.status(statusCode).json({
            success: false,
            metaError: fullError
        });
    }
});



async function handlePhoneNotFound(reason,webhookBody) {

    try {

        console.log("webhookBody.....",webhookBody);

        const change = webhookBody.entry?.[ 0 ]?.changes?.[ 0 ];

        if(!change) {
            console.log("No change object found.");
            return;
        }

        const field = change.field;
        const value = change.value;

        // ✅ Correct check
        if(field !== 'message_template_status_update' &&
            field !== 'message_template_components_update' &&
            field !== 'message_template_quality_update') {
            console.log("Not a template status update event:",field);
            return;
        }

        // ✅ Correct fields
        const templateId = value?.message_template_id;
        const templateName = value?.message_template_name;
        const status = value?.event; // APPROVED / REJECTED / etc

        // ✅ Extract WABA ID
        const wabaId = webhookBody.entry?.[ 0 ]?.id;

        if(!wabaId) {
            console.log("WABA ID not found in webhook.");
            return;
        }

        console.log("Searching customer by WABA ID:",wabaId);

        let matchedCustomer = null;

        for(const phoneId in customers) {

            if(customers[ phoneId ].wabaId === wabaId) {
                matchedCustomer = customers[ phoneId ];
                break;
            }
        }

        if(!matchedCustomer) {
            console.log("No customer matched for WABA ID:",wabaId);
            return;
        }

        console.log("Customer matched. Sending to Salesforce...");

        // ✅ Send to Salesforce
        await axios.post(
            matchedCustomer.webhook_template_url,
            {
                templateId: templateId,
                templateName: templateName,
                status: status,
                reason: value?.reason || reason,
                wabaId: wabaId,
                fullWebhook: webhookBody
            },
            {
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log("Salesforce updated successfully (via WABA match).");

    } catch(error) {

        console.error(
            "handlePhoneNotFound Error:",
            error.response?.data || error.message
        );
    }
}