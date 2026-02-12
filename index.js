require('dotenv').config();
const express = require('express');
const axios = require('axios');
const {Sequelize,DataTypes} = require('sequelize');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* ==============================
   🔌 PostgreSQL Connection
============================== */

const sequelize = new Sequelize(process.env.DATABASE_URL,{
    dialect: 'postgres',
    protocol: 'postgres',
    logging: false,
    dialectOptions: {
        ssl: {
            require: true,
            rejectUnauthorized: false
        }
    }
});

sequelize.authenticate()
    .then(() => console.log('✅ PostgreSQL Connected'))
    .catch(err => console.error('PostgreSQL Error:',err));


/* ==============================
   📦 MODELS
============================== */

// Customer Table
const Customer = sequelize.define('Customer',{
    customer_id: {
        type: DataTypes.STRING,
        allowNull: false
    },
    phone_number_id: {
        type: DataTypes.STRING,
        allowNull: false
    },
    webhook_url: {
        type: DataTypes.STRING,
        allowNull: false
    },
    active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    }
});

// Message Table
const Message = sequelize.define('Message',{
    phone_number_id: DataTypes.STRING,
    from_number: DataTypes.STRING,
    message_id: DataTypes.STRING,
    payload: DataTypes.JSON,
    status: {
        type: DataTypes.STRING,
        defaultValue: 'pending'
    }
});

// Sync tables
sequelize.sync();


/* ----------------------------------
   1️⃣ Health Route
-----------------------------------*/
app.get('/',(req,res) => {
    res.send('Convoforce Middleware Running ✅');
});


/* ----------------------------------
   2️⃣ Webhook Verification
-----------------------------------*/
app.get('/webhook',(req,res) => {

    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

    const mode = req.query[ 'hub.mode' ];
    const token = req.query[ 'hub.verify_token' ];
    const challenge = req.query[ 'hub.challenge' ];

    if(mode && token === VERIFY_TOKEN) {
        console.log("Webhook Verified ✅");
        return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
});


/* ----------------------------------
   3️⃣ Receive Meta Webhook
-----------------------------------*/
app.post('/webhook',async (req,res) => {

    try {

        const entry = req.body.entry?.[ 0 ];
        const changes = entry?.changes?.[ 0 ];
        const value = changes?.value;
        const message = value?.messages?.[ 0 ];
        const phoneNumberId = value?.metadata?.phone_number_id;

        if(!message) {
            return res.sendStatus(200);
        }

        // 🔎 Find Customer
        const customer = await Customer.findOne({
            where: {
                phone_number_id: phoneNumberId,
                active: true
            }
        });

        if(!customer) {
            console.log("❌ Customer not found for phone:",phoneNumberId);
            return res.sendStatus(200);
        }

        // 💾 Store message
        await Message.create({
            phone_number_id: phoneNumberId,
            from_number: message.from,
            message_id: message.id,
            payload: req.body
        });

        // 📤 Forward to customer org
        await axios.post(customer.webhook_url,req.body,{
            headers: {'Content-Type': 'application/json'}
        });

        res.sendStatus(200);

    } catch(error) {
        console.error("Webhook Error:",
            error.response?.data || error.message);
        res.sendStatus(500);
    }
});


/* ----------------------------------
   4️⃣ Send Message to Meta
-----------------------------------*/
app.post('/send',async (req,res) => {

    try {

        const {to,message,phone_number_id} = req.body;

        const customer = await Customer.findOne({
            where: {
                phone_number_id,
                active: true
            }
        });

        if(!customer) {
            return res.status(400).json({error: "Customer not found"});
        }

        const response = await axios.post(
            `https://graph.facebook.com/v23.0/${ phone_number_id }/messages`,
            {
                messaging_product: "whatsapp",
                to,
                type: "text",
                text: {body: message}
            },
            {
                headers: {
                    Authorization: `Bearer ${ process.env.WHATSAPP_TOKEN }`,
                    "Content-Type": "application/json"
                }
            }
        );

        res.status(200).json(response.data);

    } catch(error) {
        console.error("Send Error:",
            error.response?.data || error.message);
        res.status(500).json({error: "Send Failed"});
    }
});


app.listen(PORT,() => {
    console.log(`🚀 Middleware running on port ${ PORT }`);
});