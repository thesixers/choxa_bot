import pg from "pg";
import dotenv from "dotenv";
import {
  getAllHotspotUsers,
  removeActiveSessions,
  getMikrotikClient,
} from "./src/mikrotik.js";

dotenv.config();

const db = new pg.Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
});

async function cleanMikrotik() {
  console.log("🔍 Connecting to MikroTik via HTTP REST API to find orphaned users...");
  const client = getMikrotikClient();

  try {
    // Fetch all users in MikroTik via GET /ip/hotspot/user
    const mikrotikUsers = await getAllHotspotUsers();
    console.log(`📡 Found ${mikrotikUsers.length} users currently provisioned in MikroTik.`);

    let removedCount = 0;
    let skippedCount = 0;

    const ignoredUsers = ["default", "admin", "default-trial"];

    for (const mkUser of mikrotikUsers) {
      const username = mkUser.name;

      // Ignore default admin or empty names, plus special protected users
      if (!username || ignoredUsers.includes(username.toLowerCase())) continue;

      // Check the database if this ticket PIN has an active, valid subscription
      const res = await db.query(
        `
        SELECT s.id 
        FROM subscriptions s
        LEFT JOIN users u ON u.id = s.user_id
        WHERE (s.pin = $1 OR u.hotspot_username = $1)
          AND s.status = 'active' 
          AND s.expiry_time > NOW()
      `,
        [username],
      );

      if (res.rowCount === 0) {
        // This user is in MikroTik but has NO valid active subscription in the DB!
        console.log(`⚠️ User '${username}' has no active DB subscription. Removing from MikroTik...`);

        try {
          await removeActiveSessions(username); // Kick active session if connected
          // DELETE /ip/hotspot/user/<userid>
          await client.delete(`/ip/hotspot/user/${encodeURIComponent(mkUser[".id"])}`);
          console.log(`   ✅ Successfully deleted '${username}' from MikroTik.`);
          removedCount++;
        } catch (err) {
          console.error(`   ❌ Failed to delete '${username}':`, err.message);
        }
      } else {
        // They have a valid subscription, leave them alone
        skippedCount++;
      }
    }

    console.log(
      `\n🎉 Cleanup Complete! Removed ${removedCount} orphaned users. (Skipped ${skippedCount} valid active users).`,
    );
    process.exit(0);
  } catch (err) {
    console.error("❌ MikroTik HTTP cleanup failed:", err.message);
    process.exit(1);
  }
}

cleanMikrotik();
