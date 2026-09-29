/**
 * Purge Dead Hotspot Tickets Script (Choice A: Safest Mode)
 *
 * Safety Rules:
 *  1. NEVER touches protected system accounts: admin, default, default-trial
 *  2. NEVER touches currently connected users (/ip/hotspot/active)
 *  3. NEVER touches active bot tickets in DB (valid subscriptions or unactivated)
 *  4. NEVER touches unused tickets (uptime = 00:00:00 and bytes = 0) to protect
 *     any unsold or unactivated old paper vouchers!
 *
 * What it REMOVES (100% Dead / Unusable Tickets):
 *  - Tickets that reached their uptime limit (uptime >= limit-uptime)
 *  - Disabled tickets (disabled = true)
 *  - Expired bot tickets in DB that are not connected
 *
 * Usage:
 *  - Dry Run (default, safe preview):
 *      node --env-file=.env db/purge-dead-tickets.js
 *
 *  - Real Execution (actually deletes dead tickets):
 *      CONFIRM=yes node --env-file=.env db/purge-dead-tickets.js
 */

import pg from "pg";
import axios from "axios";

const IS_REAL_RUN = process.env.CONFIRM === "yes";

// ── Database Pool ─────────────────────────────────────────────────────────────
const db = new pg.Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT || 5432,
});

// ── MikroTik REST Client ──────────────────────────────────────────────────────
function getMikrotikClient() {
  const host = process.env.MIKROTIK_TUNNEL_IP;
  const port = process.env.MIKROTIK_PORT || 80;
  const user = process.env.MIKROTIK_USER;
  const pass = process.env.MIKROTIK_PASS;
  const portSuffix = String(port) === "80" ? "" : `:${port}`;
  return axios.create({
    baseURL: `http://${host}${portSuffix}/rest`,
    auth: { username: user, password: pass },
    timeout: 15000,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
}

/**
 * Parses any RouterOS time string into total seconds.
 * Handles: "1d 00:00:00", "0d 01:00:00", "12:30:00", "4w2d", "1h20m30s", "0s", "none"
 * @param {string|null} str
 * @returns {number} seconds
 */
export function parseRouterOSTime(str) {
  if (!str) return 0;
  str = String(str).trim().toLowerCase();
  if (str === "0" || str === "0s" || str === "00:00:00" || str === "none") return 0;

  let totalSeconds = 0;
  let remaining = str;

  // Weeks (e.g. 4w)
  const weekMatch = remaining.match(/^(\d+)w\s*/);
  if (weekMatch) {
    totalSeconds += parseInt(weekMatch[1], 10) * 7 * 86400;
    remaining = remaining.slice(weekMatch[0].length);
  }

  // Days (e.g. 1d or 7d)
  const dayMatch = remaining.match(/^(\d+)d\s*/);
  if (dayMatch) {
    totalSeconds += parseInt(dayMatch[1], 10) * 86400;
    remaining = remaining.slice(dayMatch[0].length);
  }

  // HH:MM:SS or H:M:S
  const hmsMatch = remaining.match(/^(\d+):(\d+):(\d+)$/);
  if (hmsMatch) {
    totalSeconds += parseInt(hmsMatch[1], 10) * 3600;
    totalSeconds += parseInt(hmsMatch[2], 10) * 60;
    totalSeconds += parseInt(hmsMatch[3], 10);
    return totalSeconds;
  }

  // MM:SS
  const msMatch = remaining.match(/^(\d+):(\d+)$/);
  if (msMatch) {
    totalSeconds += parseInt(msMatch[1], 10) * 60;
    totalSeconds += parseInt(msMatch[2], 10);
    return totalSeconds;
  }

  // Short form e.g. 2h15m30s
  const hMatch = remaining.match(/(\d+)h/);
  if (hMatch) totalSeconds += parseInt(hMatch[1], 10) * 3600;

  const mMatch = remaining.match(/(\d+)m/);
  if (mMatch) totalSeconds += parseInt(mMatch[1], 10) * 60;

  const sMatch = remaining.match(/(\d+)s/);
  if (sMatch) totalSeconds += parseInt(sMatch[1], 10);

  return totalSeconds;
}

async function run() {
  console.log("\n============================================================");
  console.log("🧹 MIKROTIK DEAD TICKET PURGE TOOL (Choice A: Safest Mode)");
  console.log(IS_REAL_RUN ? "⚠️  REAL RUN MODE — DEAD TICKETS WILL BE DELETED" : "🔍 DRY RUN MODE — Preview only, no changes will be made");
  console.log("============================================================\n");

  const client = getMikrotikClient();
  const now = new Date();

  // 1. Fetch all router users
  console.log("📡 Step 1: Fetching all hotspot users from MikroTik...");
  let routerUsers = [];
  try {
    const res = await client.get("/ip/hotspot/user");
    routerUsers = Array.isArray(res.data) ? res.data : (res.data ? [res.data] : []);
  } catch (err) {
    console.error("❌ Failed to reach MikroTik:", err.message);
    await db.end();
    process.exit(1);
  }
  console.log(`   → Found ${routerUsers.length} total users on router.\n`);

  // 2. Fetch all active sessions
  console.log("📡 Step 2: Fetching currently online sessions...");
  let activeSessions = [];
  try {
    const res = await client.get("/ip/hotspot/active");
    activeSessions = Array.isArray(res.data) ? res.data : (res.data ? [res.data] : []);
  } catch (err) {
    console.warn("⚠️ Could not fetch active sessions:", err.message);
  }
  const activePins = new Set(activeSessions.map((s) => String(s.user)));
  console.log(`   → Found ${activePins.size} devices currently connected.\n`);

  // 3. Fetch all subscriptions from DB
  console.log("📡 Step 3: Fetching subscriptions from local database...");
  let dbSubs = new Map();
  try {
    const { rows } = await db.query(`
      SELECT s.id, s.pin, s.status, s.start_time, s.expiry_time, pl.name AS plan_name, u.phone
      FROM subscriptions s
      JOIN plans pl ON pl.id = s.plan_id
      LEFT JOIN users u ON u.id = s.user_id
    `);
    for (const r of rows) {
      if (r.pin) dbSubs.set(String(r.pin), r);
    }
    console.log(`   → Found ${dbSubs.size} ticket record(s) in PostgreSQL.\n`);
  } catch (err) {
    console.warn("⚠️ DB query warning:", err.message);
  }

  // 4. Categorize each user
  const SYSTEM_NAMES = new Set(["default", "admin", "default-trial"]);

  let protectedSystem = [];
  let connectedNow    = [];
  let validBotTickets = [];
  let unusedKept      = [];
  let deadToRemove    = [];

  for (const ru of routerUsers) {
    const pin = String(ru.name || "");
    if (!pin) continue;

    // A. Protected system user
    if (SYSTEM_NAMES.has(pin.toLowerCase())) {
      protectedSystem.push(pin);
      continue;
    }

    // B. Currently online right now
    if (activePins.has(pin)) {
      connectedNow.push(pin);
      continue;
    }

    // C. Check database record
    const sub = dbSubs.get(pin);
    if (sub && sub.status === "active") {
      const isExpiredInDb = sub.expiry_time && new Date(sub.expiry_time) < now;
      if (!isExpiredInDb) {
        // Valid active bot ticket (or unactivated waiting for first login)
        validBotTickets.push({ pin, plan: sub.plan_name, expiry: sub.expiry_time || "Pending first login" });
        continue;
      }
    }

    // D. Analyze router usage stats
    const uptimeSec = parseRouterOSTime(ru.uptime);
    const limitSec  = parseRouterOSTime(ru["limit-uptime"]);
    const bytesIn   = parseInt(ru["bytes-in"] || 0, 10) || 0;
    const bytesOut  = parseInt(ru["bytes-out"] || 0, 10) || 0;
    const totalBytes = bytesIn + bytesOut;

    // E. Unused voucher (0 uptime and 0 bytes) -> KEEP SAFE for Choice A!
    if (uptimeSec === 0 && totalBytes === 0) {
      unusedKept.push({ pin, profile: ru.profile });
      continue;
    }

    // F. Identify 100% Dead Tickets
    const isDisabled = ru.disabled === "true" || ru.disabled === true;
    const isLimitReached = limitSec > 0 && uptimeSec >= limitSec;
    const isDbExpired = sub && (sub.status === "expired" || (sub.expiry_time && new Date(sub.expiry_time) < now));

    if (isDisabled || isLimitReached || isDbExpired) {
      let reason = "Expired";
      if (isDisabled) reason = "Account disabled";
      else if (isLimitReached) reason = `Uptime limit reached (${ru.uptime || "0s"} / ${ru["limit-uptime"]})`;
      else if (isDbExpired) reason = `DB marked expired (${sub.plan_name})`;

      deadToRemove.push({ routerUser: ru, reason, sub });
    } else {
      // Partially used but hasn't reached limit yet — leave safe
      unusedKept.push({ pin, profile: ru.profile, note: `Incomplete usage (${ru.uptime || "0s"})` });
    }
  }

  // 5. Print Audit Report
  console.log("============================================================");
  console.log("📊 AUDIT RESULTS SUMMARY");
  console.log("============================================================");
  console.log(`🛡️  Protected system accounts             : ${protectedSystem.length}`);
  console.log(`🟢 Currently connected users (UNTOUCHED) : ${connectedNow.length}`);
  console.log(`✅ Valid Bot tickets in DB (UNTOUCHED)   : ${validBotTickets.length}`);
  console.log(`⏳ Unused vouchers kept safe (Choice A)  : ${unusedKept.length}`);
  console.log(`------------------------------------------------------------`);
  console.log(`💀 100% DEAD TICKETS IDENTIFIED          : ${deadToRemove.length}`);
  console.log("============================================================\n");

  if (!deadToRemove.length) {
    console.log("🎉 No dead tickets found! Router is already clean.\n");
    await db.end();
    return;
  }

  // Sample preview of dead tickets
  console.log(`📋 Sample of dead tickets to be removed (first 10 of ${deadToRemove.length}):`);
  deadToRemove.slice(0, 10).forEach(({ routerUser, reason }) => {
    console.log(`   PIN ${routerUser.name} | Profile: ${routerUser.profile || "default"} | ${reason}`);
  });
  console.log("");

  if (!IS_REAL_RUN) {
    console.log("ℹ️  This was a DRY RUN. No tickets were deleted.");
    console.log("👉 To delete these dead tickets, run:");
    console.log("   CONFIRM=yes node --env-file=.env db/purge-dead-tickets.js\n");
    await db.end();
    return;
  }

  // 6. Real Deletion Execution
  console.log(`🚀 Starting deletion of ${deadToRemove.length} dead tickets...\n`);
  let deletedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < deadToRemove.length; i++) {
    const { routerUser, sub } = deadToRemove[i];
    const pin = routerUser.name;
    const rid = routerUser[".id"];

    try {
      await client.delete(`/ip/hotspot/user/${encodeURIComponent(rid)}`);
      deletedCount++;

      // If in DB, ensure status is marked expired
      if (sub && sub.id) {
        await db.query(`UPDATE subscriptions SET status = 'expired' WHERE id = $1`, [sub.id]).catch(() => {});
      }

      // Progress indicator every 100 items
      if (deletedCount % 100 === 0 || i === deadToRemove.length - 1) {
        console.log(`   🧹 Deleted ${deletedCount}/${deadToRemove.length} dead tickets...`);
      }
    } catch (err) {
      if (err.response?.status === 404) {
        deletedCount++;
      } else {
        errorCount++;
        console.error(`   ❌ Failed to delete PIN ${pin}:`, err.message);
      }
    }
  }

  console.log("\n============================================================");
  console.log("🎉 CLEANUP COMPLETE!");
  console.log(`   ✅ Successfully Deleted : ${deletedCount}`);
  console.log(`   ❌ Errors               : ${errorCount}`);
  console.log(`   🛡️ Safe Users Preserved : ${connectedNow.length + validBotTickets.length + unusedKept.length}`);
  console.log("============================================================\n");

  await db.end();
}

run().catch(async (err) => {
  console.error("Fatal error:", err.message);
  await db.end();
  process.exit(1);
});
