// Import the nodemailer library
// Nodemailer is the standard way to send emails in Node.js
const nodemailer = require('nodemailer');

// Create a reusable transporter object using SMTP transport
// It picks up configuration from environment variables
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465', // true for 465, false for other ports
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

// Export the mailer service module
// This encapsulates our email sending logic
module.exports = {
    async sendLoginCode(code) {
        const adminEmails = process.env.ADMIN_EMAILS || process.env.ALERT_EMAILS;
        if (!adminEmails) {
            throw new Error('No ADMIN_EMAILS or ALERT_EMAILS configured');
        }

        const recipients = adminEmails.split(',').map(email => email.trim()).filter(Boolean);
        await Promise.all(recipients.map(email => transporter.sendMail({
            from: `"Home Check Security" <${process.env.SMTP_USER}>`,
            to: email,
            subject: 'Home Check dashboard access code',
            text: `Your Home Check dashboard access code is ${code}. It expires in 10 minutes and can only be used once.`
        })));
    },

    // Function to send an alert email
    // It takes a subject string and an HTML/text body
    async sendAlert(subject, body) {
        // Fetch the comma-separated list of recipient emails
        // If none are configured, log a warning and exit early
        const alertEmails = process.env.ALERT_EMAILS;
        if (!alertEmails) {
            console.warn('No ALERT_EMAILS configured. Skipping email alert.');
            return;
        }

        try {
            // Split the comma-separated string into an array of emails
            // We use map(trim) to remove any accidental spaces
            const recipients = alertEmails.split(',').map(e => e.trim());

            // Loop through each recipient and send the email
            // We do this sequentially here, but could be concurrent with Promise.all
            for (const email of recipients) {
                // Send the email using the configured transporter
                // We await the result to ensure it completes
                await transporter.sendMail({
                    from: `"Home Check Alert" <${process.env.SMTP_USER}>`,
                    to: email,
                    subject: subject,
                    text: body,
                });
                console.log(`Alert email sent to ${email}`);
            }
        } catch (error) {
            // Catch and log any errors during email transmission
            // We do not throw the error because we don't want to crash the server
            console.error('Failed to send alert email:', error);
        }
    }
};
