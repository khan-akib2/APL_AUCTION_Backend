import nodemailer from 'nodemailer';

function createTransporter() {
  const user = process.env.GMAIL_USER || process.env.SMTP_USER;
  const pass = process.env.GMAIL_PASS || process.env.SMTP_PASS;

  if (!user || !pass) {
    return null;
  }

  // If using Gmail directly
  if (user.includes('@gmail.com') || process.env.GMAIL_USER) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
    });
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 465,
    secure: process.env.SMTP_SECURE === 'true' || true,
    auth: { user, pass },
  });
}

export async function sendCaptainCredentials({ name, email, password, teamName = '', sport = 'cricket' }) {
  const sportLabel = sport === 'football' ? 'Football' : 'Cricket';
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const subject = `Your APL ${sportLabel} Captain Credentials`;

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0a1628; color: #ffffff; margin: 0; padding: 24px; }
        .card { background-color: #0d1e3a; border: 1px solid #c9a227; border-radius: 16px; padding: 32px; max-width: 540px; margin: 0 auto; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        .header { text-align: center; margin-bottom: 24px; }
        .title { color: #c9a227; font-size: 20px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; margin: 0; }
        .subtitle { color: #94a3b8; font-size: 13px; margin-top: 4px; }
        .badge { display: inline-block; padding: 4px 12px; background: rgba(201, 162, 39, 0.15); border: 1px solid rgba(201, 162, 39, 0.4); border-radius: 9999px; color: #c9a227; font-size: 11px; font-weight: 700; text-transform: uppercase; margin-top: 8px; }
        .content { color: #e2e8f0; font-size: 14px; line-height: 1.6; margin-bottom: 24px; }
        .credentials-box { background-color: #071322; border: 1px dashed rgba(201, 162, 39, 0.35); border-radius: 12px; padding: 20px; margin: 20px 0; }
        .row { display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 14px; }
        .row:last-child { margin-bottom: 0; }
        .label { color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
        .value { color: #ffffff; font-weight: 700; font-family: monospace; font-size: 14px; }
        .btn { display: block; text-align: center; background-color: #c9a227; color: #0a1628; font-weight: 800; font-size: 14px; text-decoration: none; padding: 14px 24px; border-radius: 10px; margin: 24px 0 12px 0; }
        .footer { text-align: center; color: #64748b; font-size: 11px; margin-top: 24px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 16px; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <h1 class="title">APL Sports Auction</h1>
          <div class="subtitle">Official Team Captain Access</div>
          <div class="badge">${sportLabel} Championship</div>
        </div>
        <div class="content">
          <p>Hello <strong>${name}</strong>,</p>
          <p>You have been registered as the official Captain for ${teamName ? `<strong>${teamName}</strong>` : 'your team'} in the upcoming <strong>APL ${sportLabel} Auction</strong>.</p>
          <p>Use the credentials below to log in to your captain bidding terminal:</p>
          
          <div class="credentials-box">
            <div class="row">
              <span class="label">Login Portal:</span>
              <span class="value"><a href="${frontendUrl}/login" style="color: #c9a227;">${frontendUrl}/login</a></span>
            </div>
            <div class="row">
              <span class="label">Email:</span>
              <span class="value">${email}</span>
            </div>
            <div class="row">
              <span class="label">Password:</span>
              <span class="value">${password}</span>
            </div>
            ${teamName ? `
            <div class="row">
              <span class="label">Assigned Team:</span>
              <span class="value">${teamName}</span>
            </div>
            ` : ''}
          </div>

          <a href="${frontendUrl}/login" class="btn">Sign In to Captain Portal</a>
          <p style="font-size: 12px; color: #94a3b8; text-align: center;">Please keep your password secure. Do not share your login with other teams.</p>
        </div>
        <div class="footer">
          &copy; ${new Date().getFullYear()} APL Sports Auction. All rights reserved.
        </div>
      </div>
    </body>
    </html>
  `;

  const transporter = createTransporter();
  if (!transporter) {
    console.log(`[Mailer] (Simulation - Add GMAIL_USER and GMAIL_PASS in .env to deliver via Gmail)`);
    console.log(`[Mailer] To: ${email} | Subject: ${subject}`);
    console.log(`[Mailer] Credentials => Email: ${email} | Password: ${password} | Sport: ${sportLabel}`);
    return { success: true, simulated: true };
  }

  try {
    const info = await transporter.sendMail({
      from: `"APL Auction" <${process.env.GMAIL_USER || process.env.SMTP_USER}>`,
      to: email,
      subject,
      html,
    });
    console.log(`[Mailer] Successfully sent credentials email to ${email}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[Mailer] Failed to send email to ${email}:`, err.message);
    return { success: false, error: err.message };
  }
}
