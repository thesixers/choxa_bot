/**
 * Cleanup script — MikroTik is the source of truth.
 *
 * Logic:
 *  1. Fetch ALL hotspot users from the router
 *  2. Fetch currently active sessions
 *  3. For each router user look it up in our DB by PIN:
 *     - SKIP  → currently connected right now (mid-session)
 *     - SKIP  → not found in our DB (manual/walk-in entry)
 *     - SKIP  → expiry_time is in the future (still valid)
 *     - REMOVE → expiry_time has passed (wall-clock expired)
 *     - REMOVE → DB status is already 'expired' but still on router (orphan)
 *
 * Run with:  node --env-file=.env db/cleanup-expired.js
 * Dry run:   DRY_RUN=true node --env-file=.env db/cleanup-expired.js
 */

import pg from "pg";
import axios from "axios";

const DRY_RUN = process.env.DRY_RUN === "true";
if (DRY_RUN) console.log("⚠️  DRY RUN MODE — no changes will be made\n");

// ── DB ───────────────────────────────────────────────────────────────────────
const db = new pg.Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT || 5432,
});

// ── MikroTik client ──────────────────────────────────────────────────────────
function getMikrotikClient() {
  const host = process.env.MIKROTIK_TUNNEL_IP;
  const port = process.env.MIKROTIK_PORT || 80;
  const user = process.env.MIKROTIK_USER;
  const pass = process.env.MIKROTIK_PASS;
  const portSuffix = String(port) === "80" ? "" : `:${port}`;
  return axios.create({
    baseURL: `http://${host}${portSuffix}/rest`,
    auth: { username: user, password: pass },
    timeout: 10000,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
}

async function run() {
  const client = getMikrotikClient();
  const now = new Date();

  // ── Step 1: Fetch ALL hotspot users from router ──────────────────────────
  console.log("📡 Fetching all hotspot users from MikroTik...");
  let routerUsers = [];
  try {
    const res = await client.get("/ip/hotspot/user");
    routerUsers = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
  } catch (err) {
    console.error("❌ Could not reach MikroTik:", err.message);
    await db.end();
    process.exit(1);
  }

  if (!routerUsers.length) {
    console.log("✅ No hotspot users on the router. Nothing to clean.\n");
    await db.end();
    return;
  }
  console.log(`   → ${routerUsers.length} user(s) found on router`);

  // ── Step 2: Fetch currently ACTIVE sessions ──────────────────────────────
  console.log("📡 Fetching active sessions from MikroTik...");
  let activeSessions = [];
  try {
    const res = await client.get("/ip/hotspot/active");
    activeSessions = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
  } catch (err) {
    console.warn("⚠️  Could not fetch active sessions:", err.message);
  }
  const activePins = new Set(activeSessions.map((s) => s.user));
  console.log(`   → ${activePins.size} user(s) currently connected\n`);

  // ── Step 3: Categorise each router user ──────────────────────────────────
  let toRemove     = [];
  let stillActive  = [];
  let connectedNow = [];
  let notInDb      = [];

  for (const ru of routerUsers) {
    const pin = ru.name;

    // Currently connected — never remove mid-session
    if (activePins.has(pin)) {
      connectedNow.push(pin);
      continue;
    }

    // Look up in our DB by PIN
    const { rows } = await db.query(
      `SELECT s.id, s.status, s.expiry_time, u.phone, pl.name AS plan_name
       FROM subscriptions s
       JOIN users u  ON u.id  = s.user_id
       JOIN plans pl ON pl.id = s.plan_id
       WHERE s.pin = $1
       LIMIT 1`,
      [pin]
    );

    if (!rows.length) {
      // Not our ticket — skip
      notInDb.push(pin);
      continue;
    }

    const sub = rows[0];
    const isExpiredByTime = sub.expiry_time && new Date(sub.expiry_time) < now;
    const isOrphan        = sub.status === "expired"; // DB expired but still on router

    if (isExpiredByTime || isOrphan) {
      const reason = isOrphan && !isExpiredByTime
        ? "DB already marked expired (orphan on router)"
        : `expired at ${new Date(sub.expiry_time).toLocaleString()}`;
      toRemove.push({ routerUser: ru, sub, reason });
    } else {
      stillActive.push({ pin, plan_name: sub.plan_name, phone: sub.phone, expiry_time: sub.expiry_time });
    }
  }

  // ── Step 4: Print full report ─────────────────────────────────────────────
  console.log("─".repeat(60));

  console.log(`\n✅ ACTIVE — will NOT be touched (${stillActive.length})`);
  stillActive.forEach((r) =>
    console.log(`   PIN ${r.pin} | ${r.plan_name} | ${r.phone} | expires ${new Date(r.expiry_time).toLocaleString()}`)
  );

  console.log(`\n🟢 CONNECTED RIGHT NOW — skipped (${connectedNow.length})`);
  connectedNow.forEach((pin) => console.log(`   PIN ${pin}`));

  console.log(`\n⚠️  NOT IN OUR DB — skipped (${notInDb.length})`);
  notInDb.forEach((pin) => console.log(`   PIN ${pin}`));

  console.log(`\n🗑️  TO BE REMOVED — expired (${toRemove.length})`);
  toRemove.forEach((r) =>
    console.log(`   PIN ${r.routerUser.name} | ${r.sub.plan_name} | ${r.sub.phone} — ${r.reason}`)
  );
  console.log("\n" + "─".repeat(60));

  if (!toRemove.length) {
    console.log("\n✅ Nothing to remove. All router users are valid or unrecognised.\n");
    await db.end();
    return;
  }

  if (DRY_RUN) {
    console.log("\n⚠️  DRY RUN — no deletions performed.\n");
    await db.end();
    return;
  }

  // ── Step 5: Remove expired users from router + update DB ─────────────────
  console.log("\n🧹 Removing expired users...\n");
  let removed = 0, errors = 0;

  for (const { routerUser, sub } of toRemove) {
    const pin = routerUser.name;
    const rid = routerUser[".id"];

    try {
      await client.delete(`/ip/hotspot/user/${encodeURIComponent(rid)}`);
      console.log(`  🗑️  Removed PIN ${pin} from router`);
      removed++;
    } catch (err) {
      if (err.response?.status === 404) {
        console.log(`  ⚠️  PIN ${pin} already gone from router`);
        removed++;
      } else {
        console.error(`  ❌  Failed to remove PIN ${pin}:`, err.message);
        errors++;
        continue; // don't mark DB if router removal failed
      }
    }

    await db.query(`UPDATE subscriptions SET status = 'expired' WHERE id = $1`, [sub.id]);
    console.log(`  ✅  DB subscription ${sub.id} marked expired\n`);
  }

  // ── Step 6: Summary ───────────────────────────────────────────────────────
  console.log("─".repeat(60));
  console.log(`\n🎉 Done!`);
  console.log(`  🗑️  Removed          : ${removed}`);
  console.log(`  ❌  Errors           : ${errors}`);
  console.log(`  🟢  Active kept      : ${stillActive.length + connectedNow.length}`);
  console.log(`  ⚠️   Skipped (no DB)  : ${notInDb.length}\n`);

  await db.end();
}

run().catch((err) => {
  console.error("❌ Fatal error:", err.message);
  db.end();
  process.exit(1);
});
