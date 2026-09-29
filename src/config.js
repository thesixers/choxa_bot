export const config = {
  ispName: process.env.ISP_NAME || "CHOXA INTERNET",
  hotspotSsid: process.env.HOTSPOT_SSID || "CHOXA_NET",
  portalUrl: process.env.PORTAL_URL || "choxa.wifi",
  supportPhone: process.env.SUPPORT_PHONE || "07068380792",
  adminPhones: (process.env.ADMIN_PHONE || "")
    .split(",")
    .map((p) => p.trim().replace(/^\+/, ""))
    .filter(Boolean),
  telegramBotHandle: process.env.TELEGRAM_BOT_HANDLE || "",
  flwBaseUrl: process.env.FLW_BASE_URL || "https://api.flutterwave.com/v3",
  flwSecretKey: process.env.FLW_SECRET_KEY,
  flwSecretHash: process.env.FLW_SECRET_HASH,
  mikrotik: {
    host: process.env.MIKROTIK_TUNNEL_IP || "10.200.0.2",
    user: process.env.MIKROTIK_USER,
    pass: process.env.MIKROTIK_PASS,
    port: parseInt(process.env.MIKROTIK_PORT, 10) || 80,
    hotspotServer: process.env.MIKROTIK_HOTSPOT_SERVER || "all",
  },
};

export default config;
