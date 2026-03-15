const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
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

async function sendStockAlert(toEmail, item, qty) {
    await transporter.sendMail({
    from: `Clinic Inventory <${process.env.EMAIL_USER}>`,
    to: toEmail,
    subject: 'LOW STOCK ALERT',
    html: `
      <h2>Low Stock Alert</h2>
      <p><strong>Item:</strong> ${item}</p>
      <p><strong>Remaining Quantity:</strong> ${qty}</p>
      <p>Please restock immediately.</p>
    `
  });
}

module.exports = { sendStockAlert };