const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const saltRounds = 10;
const nodemailer = require('nodemailer');
const { sendStockAlert } = require("./mailer");
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// 🚨 MOVE POOL TO TOP - BEFORE ROUTES
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// TEST DATABASE CONNECTION
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('❌ Database connection failed:', err.message);
    } else {
        console.log('✅ Database connected successfully!');
    }
});

// 1. REGISTER ROUTE (with DEBUG logs)
app.post('/api/register', async (req, res) => {
    console.log('📝 Register attempt:', req.body);
    const { username, email, password } = req.body;
    
    try {
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        console.log('🔐 Hashed password:', hashedPassword.substring(0, 20) + '...');
        
        await pool.query('INSERT INTO users (username, hashed_password, email) VALUES ($1, $2, $3)', [username, hashedPassword, req.body.email]);
        console.log('✅ User registered:', username);
        res.status(201).json({ message: 'Registered successfully' });
    } catch (err) {
        console.error('❌ Register error:', err.message);
        res.status(400).json({ error: 'Registration failed: ' + err.message });
    }
});

// 2. LOGIN ROUTE (with DEBUG logs)
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        
        if (result.rows.length > 0) {
            const user = result.rows[0];
            
            // ✅ WALANG require() dito - gumamit ng TOP bcrypt
            const isMatch = await bcrypt.compare(password, user.hashed_password);
            
            if (isMatch) {
                res.json({ success: true, username: user.username, email: user.email });
            } else {
                res.json({ success: false });
            }
        } else {
            res.json({ success: false });
        }
    } catch (err) {
        console.error('Login error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});



// Configure Nodemailer Transporter
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false, 
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    tls: {
        rejectUnauthorized: false 
    }
});

transporter.verify(function (error, success) {
    if (error) {
        console.log("❌ Email Connection Error:", error.message);
    } else {
        console.log("✅ Email ready!");
    }
});

// REST OF YOUR ROUTES (unchanged)
app.get('/api/inventory', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM inventory ORDER BY item_name ASC');
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/scan/', async (req, res) =>{
    const { qrData } = req.body;

    try {
        const result = await pool.query(
            'SELECT * FROM inventory WHERE item_name = $1', 
            [qrData]
        );

        if (result.rows.length === 0) {
            return res.json({ found: false});
        }

        res.json({
            found: true,
            item: result.rows[0]
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: err.message });
    }
    
});

app.post('/api/add', async (req, res) => {
    const { item, qty, username } = req.body;

    if (!username) {
        return res.status(400).json({ error: "Username missing"})
    }

    try {
        const result = await pool.query(
            `INSERT INTO inventory (item_name, quantity, threshold)
             VALUES ($1, $2, 5)
             ON CONFLICT (item_name)
             DO UPDATE SET quantity = inventory.quantity + $2
             RETURNING *`,
            [item, parseInt(qty)]
        );

        const updatedItem = result.rows[0];

        if (updatedItem.threshold !== null && updatedItem.quantity <= updatedItem.threshold) {
            const userResult = await pool.query(
                "SELECT email FROM users WHERE username = $1",
                [username]
            );

            if (userResult.rows.length > 0) {
                await sendStockAlert(
                    userResult.rows[0].email,
                    updatedItem.item_name,
                    updatedItem.quantity
                );
            }
        }

        res.json({ success: true, item: updatedItem });

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: err.message });
    }
});


app.post('/api/withdraw', async (req, res) => {
    const { item, qty, username } = req.body;

    try {
        const result = await pool.query(
            `UPDATE inventory
             SET quantity = quantity - $1
             WHERE item_name = $2 AND quantity >= $1
             RETURNING *`,
            [qty, item]
        );

        if (result.rows.length === 0) {
            return res.status(400).send("Insufficient stock or item not found");
        }

        const updated = result.rows[0];
        console.log(`Item: ${item} | Current: ${updated.quantity} | Threshold: ${updated.threshold}`);


        if (updated.threshold !== null && updated.quantity <= updated.threshold) {
            const userResult = await pool.query(
                "SELECT email FROM users WHERE username = $1",
                [username]
            );

            if (userResult.rows.length > 0) {
                await sendStockAlert(
                    userResult.rows[0].email,
                    updated.item_name,
                    updated.quantity
                );
            }
        }

        res.json(updated);

    } catch (err) {
        console.error(err.message);
        res.status(500).send(err.message);
    }
});

// ===============================
// PHONE QR AUTO ACTION ROUTE
// ===============================
app.get('/scan', async (req, res) => {

    const { action, item, qty } = req.query;

    if (!action || !item || !qty) {
        return res.send("<h3>Invalid QR data.</h3>");
    }

    try {

        let result;

        if (action === "ADD") {

            result = await pool.query(
                `INSERT INTO inventory (item_name, quantity, threshold)
                 VALUES ($1, $2, 5)
                 ON CONFLICT (item_name)
                 DO UPDATE SET quantity = inventory.quantity + $2
                 RETURNING *`,
                [item, parseInt(qty)]
            );

        } 
        else if (action === "WITHDRAW") {

            result = await pool.query(
                `UPDATE inventory
                 SET quantity = quantity - $1
                 WHERE item_name = $2 AND quantity >= $1
                 RETURNING *`,
                [parseInt(qty), item]
            );

            if (result.rows.length === 0) {
                return res.send("<h3>Insufficient stock.</h3>");
            }

        } 
        else {
            return res.send("<h3>Invalid action.</h3>");
        }

        const updated = result.rows[0];

        res.send(`
            <h2>Transaction Successful</h2>
            <p><strong>Action:</strong> ${action}</p>
            <p><strong>Item:</strong> ${item}</p>
            <p><strong>Quantity:</strong> ${qty}</p>
            <p><strong>Remaining Stock:</strong> ${updated.quantity}</p>
        `);

    } catch (err) {
        res.send("<h3>Error: " + err.message + "</h3>");
    }

});


app.listen(5000, '0.0.0.0', () => { 
    console.log("🚀 Server running on network at port 5000")
});
