    const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

async function sendVisitConfirmation({ name, phone, project, zone, day, hour, wazeLink, clientEmail, dateStr, timeStr }) {
  const teamRecipients = [
    "gerencia@ssremodelaciones.com",
    "administraciondeproyectos@ssremodelaciones.com",
    "proyectos@ssremodelaciones.com",
  ];

  const allRecipients = [...teamRecipients];
  if (clientEmail && clientEmail !== "sin-correo" && clientEmail.includes("@")) {
    allRecipients.push(clientEmail);
  }

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1a1a2e; padding: 24px; border-radius: 8px 8px 0 0;">
        <h2 style="color: white; margin: 0;">🏗️ SS Remodelaciones</h2>
        <p style="color: #aaa; margin: 4px 0 0;">Nueva visita de diagnóstico agendada</p>
      </div>
      <div style="background: #f9f9f9; padding: 24px; border-radius: 0 0 8px 8px; border: 1px solid #eee;">
        <h3 style="color: #333; margin-top: 0;">📋 Detalles de la visita</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 8px 0; color: #666; width: 40%;">👤 Cliente</td><td style="padding: 8px 0; font-weight: bold;">${name || "—"}</td></tr>
          <tr><td style="padding: 8px 0; color: #666;">📱 WhatsApp</td><td style="padding: 8px 0;">${phone}</td></tr>
          ${clientEmail && clientEmail !== "sin-correo" ? `<tr><td style="padding: 8px 0; color: #666;">📧 Email cliente</td><td style="padding: 8px 0;">${clientEmail}</td></tr>` : ""}
          <tr><td style="padding: 8px 0; color: #666;">🏗️ Proyecto</td><td style="padding: 8px 0;">${project || "—"}</td></tr>
          <tr><td style="padding: 8px 0; color: #666;">📍 Zona</td><td style="padding: 8px 0;">${zone || "—"}</td></tr>
          <tr><td style="padding: 8px 0; color: #666;">📅 Fecha</td><td style="padding: 8px 0; font-weight: bold; color: #2e7d32;">${dateStr}</td></tr>
          <tr><td style="padding: 8px 0; color: #666;">🕐 Hora</td><td style="padding: 8px 0; font-weight: bold; color: #2e7d32;">${timeStr}</td></tr>
          ${wazeLink ? `<tr><td style="padding: 8px 0; color: #666;">🗺️ Ubicación</td><td style="padding: 8px 0;"><a href="${wazeLink}" style="color: #1565c0;">${wazeLink}</a></td></tr>` : ""}
        </table>
        <div style="background: #e8f5e9; padding: 12px 16px; border-radius: 6px; margin-top: 16px;">
          <p style="margin: 0; color: #2e7d32; font-size: 14px;">💰 Costo de la visita: <strong>₡25.000</strong> — se descuenta si contrata la obra.</p>
        </div>
        <p style="color: #999; font-size: 12px; margin-top: 24px; margin-bottom: 0;">
          Agendado automáticamente por <strong>Sasha</strong> — Bot SS Remodelaciones
        </p>
      </div>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: `"Sasha — SS Remodelaciones" <${process.env.GMAIL_USER}>`,
      to: allRecipients.join(", "),
      subject: `🗓️ Nueva visita agendada — ${name} | ${zone}`,
      html,
    });
    console.log(`📧 Email enviado a: ${allRecipients.join(", ")}`);
  } catch (err) {
    console.error("❌ Error enviando email:", err.message);
  }
}

module.exports = { sendVisitConfirmation };
